import { validateAndSanitizeUrl } from "@thoughtspot/mcp-auth";
import { VERSION_REGISTRY } from "./servers/version-registry";
import type { SessionInfo } from "./services/types";

/**
 * JSON object mapping a ThoughtSpot instance URL to the name Baton records it
 * under, e.g. {"https://team1.thoughtspot.cloud": "demo-cluster"}. Instances not
 * in the map, and every instance when the variable is unset, run without Baton.
 */
export const BATON_CLUSTERS_ENV_VAR = "BATON_CLUSTERS";

const CLUSTER_NAME_MAX_LENGTH = 64;

export class BatonClustersConfigError extends Error {}

export type BatonClusters = Map<string, string>;

/** Throws BatonClustersConfigError on malformed config. */
export function parseBatonClusters(raw: unknown): BatonClusters {
	if (raw === undefined || raw === null) {
		return new Map();
	}
	if (typeof raw === "string" && !raw.trim()) {
		return new Map();
	}

	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new BatonClustersConfigError(
				`${BATON_CLUSTERS_ENV_VAR} is not valid JSON: ${(error as Error).message}`,
			);
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new BatonClustersConfigError(
			`${BATON_CLUSTERS_ENV_VAR} must be a JSON object of instance URL -> name`,
		);
	}

	const clusters: BatonClusters = new Map();
	for (const [url, name] of Object.entries(parsed)) {
		if (
			typeof name !== "string" ||
			!name.trim() ||
			name.length > CLUSTER_NAME_MAX_LENGTH
		) {
			throw new BatonClustersConfigError(
				`${BATON_CLUSTERS_ENV_VAR} entry for "${url}" must be a name of 1 to ${CLUSTER_NAME_MAX_LENGTH} characters`,
			);
		}
		try {
			clusters.set(validateAndSanitizeUrl(url), name.trim());
		} catch (error) {
			throw new BatonClustersConfigError(
				`${BATON_CLUSTERS_ENV_VAR} has an invalid instance URL "${url}": ${(error as Error).message}`,
			);
		}
	}
	return clusters;
}

/**
 * The name for this instance, or undefined when Baton is off for it. A
 * malformed config turns Baton off rather than failing the session.
 */
export function batonClusterName(
	env: Record<string, unknown> | undefined,
	instanceUrl: string | undefined,
): string | undefined {
	if (!instanceUrl) {
		return undefined;
	}
	let clusters: BatonClusters;
	try {
		clusters = parseBatonClusters(env?.[BATON_CLUSTERS_ENV_VAR]);
	} catch (error) {
		console.error("Invalid Baton cluster configuration", error);
		return undefined;
	}
	try {
		return clusters.get(validateAndSanitizeUrl(instanceUrl));
	} catch {
		return undefined;
	}
}

/** Every tool any API version can serve, once per name. */
export function batonToolCatalog(): { name: string }[] {
	const byName = new Map<string, { name: string }>();
	for (const version of VERSION_REGISTRY) {
		for (const tool of version.tools) {
			if (!byName.has(tool.name)) {
				byName.set(tool.name, tool);
			}
		}
	}
	return [...byName.values()];
}

/**
 * Who is calling, for Baton: the ThoughtSpot user, inside their ThoughtSpot
 * Org when Orgs are on, else inside the cluster. Org ids repeat across
 * clusters, so they are prefixed with the cluster name.
 */
export function batonPrincipal(
	clusterName: string,
	session: SessionInfo | undefined,
) {
	const orgId = session?.configInfo?.orgsConfiguration?.enabled
		? session.currentOrgId
		: undefined;
	const organization =
		orgId === undefined || orgId === null || String(orgId) === ""
			? {
					organizationId: clusterName,
					displayName: clusterName,
					labels: [clusterName],
				}
			: {
					organizationId: `${clusterName}:${orgId}`,
					displayName: `${clusterName} · org ${orgId}`,
					labels: [clusterName],
				};
	if (!session?.userGUID) {
		return organization;
	}
	return {
		principalId: session.userGUID,
		displayName: session.userName || session.userGUID,
		organization,
	};
}

/**
 * Wraps the server when this session's instance is in
 * BATON_CLUSTERS and BATON_DSN is set. Never throws: a Baton problem leaves
 * the session running without it.
 */
export async function installBaton(
	server: object,
	env: Record<string, unknown> | undefined,
	instanceUrl: string | undefined,
	sessionInfo?: () => SessionInfo | undefined,
): Promise<boolean> {
	const clusterName = batonClusterName(env, instanceUrl);
	const dsn = env?.BATON_DSN;
	if (!clusterName || typeof dsn !== "string" || !dsn) {
		return false;
	}
	try {
		// Loaded only for picked instances, so other sessions never evaluate the SDK.
		const { withBaton } = await import("@goodtiming/baton-sdk");
		withBaton(server as Parameters<typeof withBaton>[0], {
			dsn,
			intentParamMode: "required",
			reportMode: "on",
			resultCaptureMode: "full",
			// Sessions list tools asynchronously and Durable Objects restart between
			// requests, so a call can reach Baton before any tools/list in that copy.
			tools: batonToolCatalog(),
			resolvePrincipal: () => {
				try {
					return batonPrincipal(clusterName, sessionInfo?.());
				} catch {
					return batonPrincipal(clusterName, undefined);
				}
			},
		});
		return true;
	} catch (error) {
		console.error("Baton install failed; continuing without it", error);
		return false;
	}
}

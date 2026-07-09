// Single source of truth for ThoughtSpot's low-level token endpoints. Both the
// SDK-based client (thoughtspot-client.ts, interactive path) and the keep-warm
// Durable Object (user-token-store-server.ts, background 11h path) mint/refresh
// tokens; this module owns the private-endpoint paths, headers, validity, and
// response shape so a change is picked up by both instead of silently drifting.

// Org-scoped token validity (24h); the keep-warm alarm re-mints it alongside the
// global token so it never expires under an active session.
export const ORG_TOKEN_VALIDITY_SEC = 24 * 60 * 60;

// Working org-token mint path is /callosum/v1/v2/auth/token/fetch (the
// /callosum/v2/... path 404s); the token is nested under data.token.
const ORG_TOKEN_PATH = "/callosum/v1/v2/auth/token/fetch";
const GLOBAL_REFRESH_PATH = "/callosum/v1/session/v2/gettoken?refresh=true";

function tokenHeaders(
	bearerToken: string,
	extra?: Record<string, string>,
): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Accept: "application/json",
		"user-agent": "ThoughtSpot-ts-client",
		Authorization: `Bearer ${bearerToken}`,
		...extra,
	};
}

// Token is nested under data.token on these endpoints but occasionally arrives
// top-level; accept either.
function extractToken(data: unknown): string | undefined {
	const d = data as { token?: unknown; data?: { token?: unknown } } | null;
	const token = d?.data?.token ?? d?.token;
	return typeof token === "string" ? token : undefined;
}

async function readJsonOrThrow(
	response: Response,
	context: string,
): Promise<unknown> {
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${context}: status ${response.status}: ${text}`);
	}
	return response.json();
}

// Mint an org-scoped token via auth/token/fetch?org_identifier=... No org header
// on the mint — the org is selected via the org_identifier query param.
export async function fetchOrgToken({
	instanceUrl,
	bearerToken,
	orgId,
	validityTimeInSec = ORG_TOKEN_VALIDITY_SEC,
}: {
	instanceUrl: string;
	bearerToken: string;
	orgId: string;
	validityTimeInSec?: number;
}): Promise<string> {
	const params = new URLSearchParams({
		validity_time_in_sec: String(validityTimeInSec),
		org_identifier: orgId,
	});
	const response = await fetch(`${instanceUrl}${ORG_TOKEN_PATH}?${params}`, {
		method: "GET",
		headers: tokenHeaders(bearerToken),
	});
	const data = await readJsonOrThrow(response, "fetchOrgToken");
	const token = extractToken(data);
	if (!token) {
		throw new Error("fetchOrgToken: no token in response");
	}
	return token;
}

// Refresh the global cluster token via gettoken?refresh=true. Returns the new
// token plus the (possibly rotated) refresh token and any new expiry.
export async function refreshGlobalToken({
	instanceUrl,
	globalToken,
	globalRefreshToken,
}: {
	instanceUrl: string;
	globalToken: string;
	globalRefreshToken: string;
}): Promise<{
	globalToken: string;
	globalRefreshToken: string;
	globalTokenExpiresAt?: number;
}> {
	const response = await fetch(`${instanceUrl}${GLOBAL_REFRESH_PATH}`, {
		method: "GET",
		headers: tokenHeaders(globalToken, {
			"X-Refresh-Token": globalRefreshToken,
		}),
	});
	const data = (await readJsonOrThrow(response, "refreshGlobalToken")) as {
		token?: string;
		refreshToken?: string;
		tokenExpiryDuration?: number;
		data?: {
			token?: string;
			refreshToken?: string;
			tokenExpiryDuration?: number;
		};
	};
	const token = extractToken(data);
	if (!token) {
		throw new Error("refreshGlobalToken: no token in response");
	}
	const newExpiresAt =
		data.tokenExpiryDuration ?? data.data?.tokenExpiryDuration;
	return {
		globalToken: token,
		globalRefreshToken:
			data.refreshToken ?? data.data?.refreshToken ?? globalRefreshToken,
		globalTokenExpiresAt:
			typeof newExpiresAt === "number" ? newExpiresAt : undefined,
	};
}

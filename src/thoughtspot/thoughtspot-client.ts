import {
	ThoughtSpotRestApi,
	createBearerAuthenticationConfig,
} from "@thoughtspot/rest-api-sdk";
import type {
	AgentConversation,
	RequestContext,
	ResponseContext,
} from "@thoughtspot/rest-api-sdk";
import { customAlphabet } from "nanoid";
import { of } from "rxjs";
import YAML from "yaml";
import type { Org, SessionInfo } from "./types";

/*
 * Inject custom handlers into the ThoughtSpot client
 */
// Header used by ThoughtSpot to select which org a request operates against.
// The same access token works across all orgs the user belongs to; the active
// org is chosen per-request via this header.
const ORG_HEADER = "x-thoughtspot-orgs";

export const getThoughtSpotClient = (
	instanceUrl: string,
	bearerToken: string,
	orgId?: string,
) => {
	const config = createBearerAuthenticationConfig(instanceUrl, () =>
		Promise.resolve(bearerToken),
	);

	config.middleware.push({
		pre: (context: RequestContext) => {
			const headers = context.getHeaders();
			if (!headers || !headers["Accept-Language"]) {
				context.setHeaderParam("Accept-Language", "en-US");
			}
			// Scope every SDK call to the active org, if one is set.
			if (orgId) {
				context.setHeaderParam(ORG_HEADER, orgId);
			}
			return of(context) as any;
		},
		post: (context: ResponseContext) => {
			return of(context) as any;
		},
	});
	const client = new ThoughtSpotRestApi(config);
	(client as any).instanceUrl = instanceUrl;
	addExportUnsavedAnswerTML(client, instanceUrl, bearerToken, orgId);
	addGetSessionInfo(client, instanceUrl, bearerToken, orgId);
	addGetAnswerSession(client, instanceUrl, bearerToken, orgId);
	addCreateAgentConversationWithAutoMode(
		client,
		instanceUrl,
		bearerToken,
		orgId,
	);
	addSendAgentConversationMessageStreaming(
		client,
		instanceUrl,
		bearerToken,
		orgId,
	);
	addFetchOrgBearerToken(client, instanceUrl);
	addListOrgs(client, instanceUrl, bearerToken);
	return client;
};

/*
 * Build the auth/content headers for the custom raw-fetch handlers below,
 * including the org-scoping header when an active org is set.
 */
function buildHeaders(
	token: string,
	orgId?: string,
	accept = "application/json",
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: accept,
		"user-agent": "ThoughtSpot-ts-client",
		Authorization: `Bearer ${token}`,
	};
	if (orgId) {
		headers[ORG_HEADER] = orgId;
	}
	return headers;
}

const getAnswerTML = `
mutation GetUnsavedAnswerTML($session: BachSessionIdInput!, $exportDependencies: Boolean, $formatType:  EDocFormatType, $exportPermissions: Boolean, $exportFqn: Boolean) {
  UnsavedAnswer_getTML(
    session: $session
    exportDependencies: $exportDependencies
    formatType: $formatType
    exportPermissions: $exportPermissions
    exportFqn: $exportFqn
  ) {
    zipFile
    object {
      edoc
      name
      type
      __typename
    }
    __typename
  }
}`;

/*
 * Using custom handler because we don't have a public API for this
 */
function addExportUnsavedAnswerTML(
	client: any,
	instanceUrl: string,
	token: string,
	orgId?: string,
) {
	(client as any).exportUnsavedAnswerTML = async ({
		session_identifier,
		generation_number,
	}: { session_identifier: string; generation_number: number }) => {
		const endpoint = "/prism/?op=GetUnsavedAnswerTML";
		// make a graphql request to `ThoughtspotHost/prism endpoint.
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: buildHeaders(token, orgId),
			body: JSON.stringify({
				operationName: "GetUnsavedAnswerTML",
				query: getAnswerTML,
				variables: {
					session: {
						sessionId: session_identifier,
						genNo: generation_number,
					},
				},
			}),
		});

		const data: any = await response.json();
		const edoc = data.data.UnsavedAnswer_getTML.object[0].edoc;
		return YAML.parse(edoc);
	};
}

/*
 * Using custom handler because we don't have a public API for this
 */
async function addGetSessionInfo(
	client: any,
	instanceUrl: string,
	token: string,
	orgId?: string,
) {
	(client as any).getSessionInfo = async (): Promise<SessionInfo> => {
		const endpoint = "/prism/preauth/info";
		// make a graphql request to `ThoughtspotHost/prism endpoint.
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "GET",
			headers: buildHeaders(token, orgId),
		});

		const data: any = await response.json();
		const info = data.info;
		return info;
	};
}

const getAnswerSessionQuery = `
mutation Answer__updateTokens($session: BachSessionIdInput!) {
  Answer__updateTokens(session: $session) {
    id {
      sessionId
      genNo
      acSession {
        genNo
        sessionId
      }
    }
  }
}`;

export interface AnswerSession {
	sessionId: string;
	genNo: number;
	acSession: {
		genNo: number;
		sessionId: string;
	};
}

/*
 * Using custom handler because we don't have a public API for this
 */
function addGetAnswerSession(
	client: any,
	instanceUrl: string,
	token: string,
	orgId?: string,
) {
	(client as any).getAnswerSession = async ({
		session_identifier,
		generation_number,
	}: {
		session_identifier: string;
		generation_number: number;
	}): Promise<AnswerSession> => {
		const endpoint = "/prism/";
		const operationName = "Answer__updateTokens";
		const fetchOptions = {
			method: "POST",
			headers: buildHeaders(token, orgId),
			body: JSON.stringify({
				operationName,
				query: getAnswerSessionQuery,
				variables: {
					session: {
						sessionId: session_identifier,
						genNo: generation_number,
					},
				},
			}),
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, fetchOptions);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`getAnswerSession failed with status ${response.status}: ${errorText}`,
			);
		}
		const data = (await response.json()) as any;
		const session = data?.data?.Answer__updateTokens?.id;
		if (!session) {
			throw new Error("Could not extract answer session from response.");
		}
		return session;
	};
}

/*
 * Using custom handler because we don't have support for Auto Mode through the public API yet
 */
function addCreateAgentConversationWithAutoMode(
	client: any,
	instanceUrl: string,
	token: string,
	orgId?: string,
) {
	(client as any).createAgentConversationWithAutoMode = async ({
		dataSourceId,
	}: {
		dataSourceId?: string;
	}): Promise<AgentConversation> => {
		const endpoint = "/conversation/v2/";
		const fetchOptions = {
			method: "POST",
			headers: buildHeaders(token, orgId),
			body: JSON.stringify({
				context: dataSourceId
					? {
							type: "worksheet",
							worksheet_context: {
								worksheet_id: dataSourceId,
							},
						}
					: {
							type: "empty",
						},
				conv_settings: {
					enable_nls: true,
					enable_why: true,
					save_chat_enabled: false,
					enable_tool_permissions: false,
					enable_search_datasets: !dataSourceId,
					enable_auto_select_dataset: !dataSourceId,
				},
			}),
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, fetchOptions);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`createAgentConversationWithAutoMode failed with status ${response.status}: ${errorText}`,
			);
		}

		const data = (await response.json()) as AgentConversation;
		return data;
	};
}

/*
 * Generator initialized once at module level so the internal buffers and state
 * are pre-computed once and reused across calls — important in streaming scenarios
 * where multiple IDs may be generated in quick succession.
 * This will become optional in future
 */
const generateNanoID = customAlphabet(
	"_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
	12,
);

/*
 * Using custom handler for two reasons:
 * 1. The REST API SDK doesn't have streaming response support
 * 2. The public API itself is exhibiting higher latency than the private API for establishing the
 *    initial connection, prior to starting the streaming response
 */
function addSendAgentConversationMessageStreaming(
	client: any,
	instanceUrl: string,
	token: string,
	orgId?: string,
) {
	(client as any).sendAgentConversationMessageStreaming = async ({
		conversation_identifier,
		message,
	}: {
		conversation_identifier: string;
		message: string;
	}): Promise<Response> => {
		// Encoding for safety, though for valid IDs it should not make a difference
		const endpoint = `/conversation/v2/${encodeURIComponent(conversation_identifier)}/query`;
		const fetchOptions = {
			method: "POST",
			headers: buildHeaders(token, orgId, "text/event-stream"),
			body: JSON.stringify({
				mode: "spotter", // TODO(Rifdhan) support deep analysis mode
				id: generateNanoID(),
				messages: [
					{
						type: "text",
						// TODO(Rifdhan) this will become optional, can remove in the future
						id: Math.random().toString(36).substring(2, 12),
						value: message,
					},
				],
			}),
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, fetchOptions);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`sendAgentConversationMessageStreaming failed with status ${response.status}: ${errorText}`,
			);
		}

		return response;
	};
}

/*
 * Lists the orgs the authenticated user is a member of, via the v1 session orgs
 * endpoint. We deliberately avoid the v2 orgs/search REST endpoint because it
 * requires ORG_ADMINISTRATION and returns 403 ("Operation is not allowed") for
 * regular (non-admin) users. This endpoint is user-scoped and available to any
 * user; it returns { orgs: [{ orgId, orgName, description, isActive }], ... }.
 */
function addListOrgs(client: any, instanceUrl: string, token: string) {
	(client as any).listOrgs = async (): Promise<Org[]> => {
		const endpoint = "/callosum/v1/session/orgs?batchsize=-1&offset=-1";
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "GET",
			headers: buildHeaders(token),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`listOrgs failed with status ${response.status}: ${errorText}`,
			);
		}

		const data = (await response.json()) as any;
		const orgs: any[] = Array.isArray(data?.orgs) ? data.orgs : [];
		return orgs.map((org) => ({
			id: Number(org.orgId ?? org.id),
			name: org.orgName ?? org.name ?? String(org.orgId ?? org.id),
			description: org.description || undefined,
		}));
	};
}

// Default validity for a minted org-scoped bearer token (30 days, in seconds),
// matching the validity the connector uses at login.
const ORG_TOKEN_VALIDITY_SEC = 30 * 24 * 60 * 60;

/*
 * Mints an ORG-SCOPED bearer token for the given org, authenticated with the
 * caller's (cluster-wide) access token. Uses the Callosum v2 auth/token/fetch
 * endpoint with org_identifier; the returned token is pinned to that org
 * server-side.
 *
 * Note: the working path on these clusters is /callosum/v1/v2/auth/token/fetch
 * (the /callosum/v2/... path 404s), and the token is nested under data.token.
 */
function addFetchOrgBearerToken(client: any, instanceUrl: string) {
	(client as any).fetchOrgBearerToken = async ({
		accessToken,
		orgId,
		validityTimeInSec = ORG_TOKEN_VALIDITY_SEC,
	}: {
		accessToken: string;
		orgId: string;
		validityTimeInSec?: number;
	}): Promise<string> => {
		const params = new URLSearchParams({
			validity_time_in_sec: String(validityTimeInSec),
			org_identifier: orgId,
		});
		const endpoint = `/callosum/v1/v2/auth/token/fetch?${params.toString()}`;
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "GET",
			// Authenticate with the access token; no org header (the org is selected
			// via org_identifier and pinned into the returned token).
			headers: buildHeaders(accessToken),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`fetchOrgBearerToken failed with status ${response.status}: ${errorText}`,
			);
		}

		const data = (await response.json()) as any;
		const token = data?.data?.token ?? data?.token;
		if (!token || typeof token !== "string") {
			throw new Error("fetchOrgBearerToken: no token in response");
		}
		return token;
	};
}

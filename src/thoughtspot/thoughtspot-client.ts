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
import { getData } from "./get-data/get-data";
import { ORG_HEADER, fetchApi } from "./rest-utils";
import { searchObjects } from "./search-objects/search-objects";
import * as spotterModel from "./spotter-model/spotter-model-client";
import { ORG_TOKEN_VALIDITY_SEC, fetchOrgToken } from "./token-endpoints";
import {
	type BachSession,
	type ClientContext,
	type Org,
	type SessionInfo,
	ThoughtSpotApiError,
} from "./types";

// Re-exported for existing importers; definitions live with the handlers.
export type {
	SearchErrorCode,
	SearchObjectHeader,
	SearchObjectResult,
	SearchObjectsError,
	SearchObjectsNoResults,
	SearchObjectsParams,
	SearchObjectsResponse,
	SearchObjectsResult,
} from "./search-objects/search-objects-types";
export type {
	GetDataParams,
	GetDataResult,
	GetDataViz,
} from "./get-data/get-data-types";
export type { ClientContext } from "./types";

// Second parameter (after ctx) of a custom handler
type Params<F> = F extends (ctx: ClientContext, params: infer P) => unknown
	? P
	: never;

function buildConfig({ instanceUrl, token, orgId }: ClientContext) {
	const config = createBearerAuthenticationConfig(instanceUrl, () =>
		Promise.resolve(token),
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
	return config;
}

/*
 * The public REST API SDK, plus custom handlers for private APIs the SDK doesn't cover. Handler
 * implementations live in plain `fn(ctx, params)` functions; methods here just bind the context.
 */
export class ThoughtSpotClient extends ThoughtSpotRestApi {
	constructor(readonly ctx: ClientContext) {
		super(buildConfig(ctx));
	}

	get instanceUrl(): string {
		return this.ctx.instanceUrl;
	}

	exportUnsavedAnswerTML(params: Params<typeof exportUnsavedAnswerTML>) {
		return exportUnsavedAnswerTML(this.ctx, params);
	}

	getSessionInfo() {
		return getSessionInfo(this.ctx);
	}

	getAnswerSession(params: Params<typeof getAnswerSession>) {
		return getAnswerSession(this.ctx, params);
	}

	createAgentConversationWithAutoMode(
		params: Params<typeof createAgentConversationWithAutoMode>,
	) {
		return createAgentConversationWithAutoMode(this.ctx, params);
	}

	// Named differently from the SDK's public-API sendAgentConversationMessageStreaming
	streamAgentConversationMessage(
		params: Params<typeof streamAgentConversationMessage>,
	) {
		return streamAgentConversationMessage(this.ctx, params);
	}

	searchObjects(params: Params<typeof searchObjects>) {
		return searchObjects(this.ctx, params);
	}

	getData(params: Params<typeof getData>) {
		return getData(this.ctx, params);
	}

	createBachPinboardSession(params: Params<typeof createBachPinboardSession>) {
		return createBachPinboardSession(this.ctx, params);
	}

	saveBachPinboard(params: Params<typeof saveBachPinboard>) {
		return saveBachPinboard(this.ctx, params);
	}

	fetchOrgBearerToken(params: Params<typeof fetchOrgBearerToken>) {
		return fetchOrgBearerToken(this.ctx, params);
	}

	listOrgs() {
		return listOrgs(this.ctx);
	}

	// Spotter Model (Lumos) agentic model-creation handlers
	mintSessionCookie() {
		return spotterModel.mintSessionCookie(this.ctx);
	}

	createModelSession(params: Params<typeof spotterModel.createModelSession>) {
		return spotterModel.createModelSession(this.ctx, params);
	}

	sendModelMessageStreaming(
		params: Params<typeof spotterModel.sendModelMessageStreaming>,
	) {
		return spotterModel.sendModelMessageStreaming(this.ctx, params);
	}

	saveModel(params: Params<typeof spotterModel.saveModel>) {
		return spotterModel.saveModel(this.ctx, params);
	}

	fetchWorksheetModel(params: Params<typeof spotterModel.fetchWorksheetModel>) {
		return spotterModel.fetchWorksheetModel(this.ctx, params);
	}
}

export const getThoughtSpotClient = (
	instanceUrl: string,
	bearerToken: string,
	orgId?: string,
) => new ThoughtSpotClient({ instanceUrl, token: bearerToken, orgId });

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
export async function exportUnsavedAnswerTML(
	ctx: ClientContext,
	{
		session_identifier,
		generation_number,
	}: { session_identifier: string; generation_number: number },
) {
	const endpoint = "/prism/?op=GetUnsavedAnswerTML";
	// make a graphql request to `ThoughtspotHost/prism endpoint.
	const response = await fetchApi(ctx, endpoint, {
		json: {
			operationName: "GetUnsavedAnswerTML",
			query: getAnswerTML,
			variables: {
				session: {
					sessionId: session_identifier,
					genNo: generation_number,
				},
			},
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"exportUnsavedAnswerTML",
			errorText,
		);
	}
	const data: any = await response.json();
	// GraphQL 200s can still carry errors
	if (data?.errors?.length) {
		throw new Error(
			`exportUnsavedAnswerTML GraphQL error: ${JSON.stringify(data.errors)}`,
		);
	}
	const edoc = data?.data?.UnsavedAnswer_getTML?.object?.[0]?.edoc;
	if (!edoc) {
		throw new Error("Could not extract TML edoc from response.");
	}
	return YAML.parse(edoc);
}

/*
 * Using custom handler because we don't have a public API for this
 */
export async function getSessionInfo(ctx: ClientContext): Promise<SessionInfo> {
	const endpoint = "/prism/preauth/info";
	const response = await fetchApi(ctx, endpoint);

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(response.status, "getSessionInfo", errorText);
	}
	const data: any = await response.json();
	const info = data?.info;
	if (!info) {
		throw new Error("Could not extract session info from response.");
	}
	return info;
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
export async function getAnswerSession(
	ctx: ClientContext,
	{
		session_identifier,
		generation_number,
	}: {
		session_identifier: string;
		generation_number: number;
	},
): Promise<AnswerSession> {
	const endpoint = "/prism/";
	const operationName = "Answer__updateTokens";
	const response = await fetchApi(ctx, endpoint, {
		json: {
			operationName,
			query: getAnswerSessionQuery,
			variables: {
				session: {
					sessionId: session_identifier,
					genNo: generation_number,
				},
			},
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"getAnswerSession",
			errorText,
		);
	}
	const data = (await response.json()) as any;
	// GraphQL 200s can still carry errors
	if (data?.errors?.length) {
		throw new Error(
			`getAnswerSession GraphQL error: ${JSON.stringify(data.errors)}`,
		);
	}
	const session = data?.data?.Answer__updateTokens?.id;
	if (!session) {
		throw new Error("Could not extract answer session from response.");
	}
	return session;
}

/*
 * Using custom handler because we don't have support for Auto Mode through the public API yet
 */
export async function createAgentConversationWithAutoMode(
	ctx: ClientContext,
	{
		isSpotterDataSourceDiscoveryEnabled,
		isSpotterChatHistoryEnabled,
		dataSourceId,
	}: {
		isSpotterDataSourceDiscoveryEnabled: boolean;
		isSpotterChatHistoryEnabled: boolean;
		dataSourceId?: string;
	},
): Promise<AgentConversation> {
	const endpoint = "/conversation/v2/";
	const response = await fetchApi(ctx, endpoint, {
		json: {
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
				enable_spotql: false,
				save_chat_enabled: isSpotterChatHistoryEnabled,
				enable_tool_permissions: false,
				enable_search_datasets:
					isSpotterDataSourceDiscoveryEnabled && !dataSourceId,
				enable_auto_select_dataset:
					isSpotterDataSourceDiscoveryEnabled && !dataSourceId,
				tags: ["mcp-server"],
			},
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"createAgentConversationWithAutoMode",
			errorText,
		);
	}

	const data = (await response.json()) as AgentConversation;
	return data;
}

/*
 * Initiate a new BACH pinboard session for a liveboard.
 */
export async function createBachPinboardSession(
	ctx: ClientContext,
	{ liveboardId }: { liveboardId: string },
): Promise<BachSession> {
	const endpoint = "/callosum/v1/bach/pinboard/";
	// Java callers (e.g. BachPinboardRequestBuilder) seed the session with a fresh GUID rather
	// than leaving the field empty; mirror that to avoid validation rejections.
	const clientTransactionId = crypto.randomUUID();
	const response = await fetchApi(ctx, endpoint, {
		json: {
			pinboardSession: { transactionId: clientTransactionId },
			pinboardRequests: [
				{
					type: "LOAD_PINBOARD",
					loadPinboard: { savedPinboardId: liveboardId },
				},
			],
		},
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`createBachPinboardSession failed with status ${response.status}: ${errorText}`,
		);
	}

	const data = (await response.json()) as {
		status?: {
			statusCode?: string;
			errorMessage?: string;
			errorCode?: string;
		};
		pinboardSession?: {
			transactionId?: string;
			generationNumber?: string | number;
		};
		pinboardResponses?: Array<{
			loadPinboard?: {
				status?: { statusCode?: string; errorMessage?: string };
			};
			status?: { statusCode?: string; errorMessage?: string };
		}>;
	};

	const statusCode = data?.status?.statusCode;
	if (statusCode && statusCode !== "OK") {
		const detail =
			data.status?.errorMessage ||
			data.pinboardResponses?.[0]?.loadPinboard?.status?.errorMessage ||
			data.pinboardResponses?.[0]?.status?.errorMessage ||
			JSON.stringify(data.status);
		throw new Error(
			`createBachPinboardSession returned non-OK status ${statusCode}: ${detail}`,
		);
	}

	const transactionId = data?.pinboardSession?.transactionId;
	const generationNumber = data?.pinboardSession?.generationNumber;
	if (!transactionId || generationNumber === undefined) {
		throw new Error(
			`createBachPinboardSession: missing session ids in response: ${JSON.stringify(data)}`,
		);
	}
	return { transactionId, generationNumber: String(generationNumber) };
}

/*
 * Save the current state of the pinboard.
 */
export async function saveBachPinboard(
	ctx: ClientContext,
	{
		transactionId,
		generationNumber,
	}: {
		transactionId: string;
		generationNumber: string;
	},
): Promise<void> {
	const endpoint = "/callosum/v1/bach/pinboard/";
	const response = await fetchApi(ctx, endpoint, {
		json: {
			pinboardSession: { transactionId, generationNumber },
			pinboardRequests: [
				{
					type: "SAVE_PINBOARD",
					savePinboard: {},
				},
			],
		},
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`saveBachPinboard failed with status ${response.status}: ${errorText}`,
		);
	}

	const data = (await response.json()) as {
		status?: {
			statusCode?: string;
			errorMessage?: string;
			errorCode?: string;
		};
		pinboardResponses?: Array<{
			savePinboard?: {
				status?: { statusCode?: string; errorMessage?: string };
			} | null;
			status?: { statusCode?: string; errorMessage?: string };
		}>;
	} | null;

	// Without this, a null or non-object body skips the status check below and the save is
	// reported as successful. Saving is what promotes the edit session to the saved liveboard, so
	// a false success here means the user's changes are silently lost.
	if (!data || typeof data !== "object") {
		throw new Error(
			`saveBachPinboard failed: non-object response body: ${JSON.stringify(data)}`,
		);
	}

	const statusCode = data?.status?.statusCode;
	if (statusCode && statusCode !== "OK") {
		const detail =
			data.status?.errorMessage ||
			data.pinboardResponses?.[0]?.savePinboard?.status?.errorMessage ||
			data.pinboardResponses?.[0]?.status?.errorMessage ||
			JSON.stringify(data.status);
		throw new Error(
			`saveBachPinboard returned non-OK status ${statusCode}: ${detail}`,
		);
	}
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
export async function streamAgentConversationMessage(
	ctx: ClientContext,
	{
		conversation_identifier,
		message,
	}: {
		conversation_identifier: string;
		message: string;
	},
): Promise<Response> {
	// Encoding for safety, though for valid IDs it should not make a difference
	const endpoint = `/conversation/v2/${encodeURIComponent(conversation_identifier)}/query`;
	const response = await fetchApi(ctx, endpoint, {
		accept: "text/event-stream",
		json: {
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
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"sendAgentConversationMessageStreaming",
			errorText,
		);
	}

	return response;
}

// Lists the user's orgs via the user-scoped v1 session/orgs endpoint. We avoid
// the v2 orgs/search REST endpoint because it needs ORG_ADMINISTRATION and 403s
// for regular users.
export async function listOrgs(ctx: ClientContext): Promise<Org[]> {
	const endpoint = "/callosum/v1/session/orgs?batchsize=-1&offset=-1";
	const response = await fetchApi(ctx, endpoint, {
		scopeToOrg: false,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(response.status, "listOrgs", errorText);
	}

	const data = (await response.json()) as any;
	const orgs: any[] = Array.isArray(data?.orgs) ? data.orgs : [];
	return orgs.map((org) => ({
		id: Number(org.orgId ?? org.id),
		name: org.orgName ?? org.name ?? String(org.orgId ?? org.id),
		description: org.description || undefined,
	}));
}

// Mint an org-scoped token. The endpoint path, headers, validity, and response
// shape are owned by ./token-endpoints (shared with the keep-warm DO).
export async function fetchOrgBearerToken(
	ctx: ClientContext,
	{
		accessToken,
		orgId,
		validityTimeInSec = ORG_TOKEN_VALIDITY_SEC,
	}: {
		accessToken: string;
		orgId: string;
		validityTimeInSec?: number;
	},
): Promise<string> {
	return fetchOrgToken({
		instanceUrl: ctx.instanceUrl,
		bearerToken: accessToken,
		orgId,
		validityTimeInSec,
	});
}

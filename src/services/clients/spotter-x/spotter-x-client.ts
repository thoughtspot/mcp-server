import type { AgentConversation } from "@thoughtspot/rest-api-sdk";
import {
	type ApiRequestOptions,
	fetchApi,
	generateRequestId,
} from "../../rest-utils";
import {
	type ClientContext,
	type LiveboardContext,
	ThoughtSpotApiError,
} from "../../types";

// SpotterX expects the fuid header and omits the org header (org is carried in the fuid)
function spotterXRequestOptions(
	tenantId: string,
	orgId: string,
	userId: string,
): ApiRequestOptions {
	return {
		scopeToOrg: false,
		requestId: generateRequestId(),
		headers: { "x-thoughtspot-fuid": `${tenantId}.${orgId}.${userId}` },
	};
}

/*
 * Create a SpotterX conversation
 */
export async function createSpotterXConversation(
	ctx: ClientContext,
	{
		isSpotterDataSourceDiscoveryEnabled,
		isSpotterChatHistoryEnabled,
		tenantId,
		orgId,
		userId,
		dataSourceId,
	}: {
		isSpotterDataSourceDiscoveryEnabled: boolean;
		isSpotterChatHistoryEnabled: boolean;
		tenantId: string;
		orgId: string;
		userId: string;
		dataSourceId?: string;
	},
): Promise<AgentConversation> {
	const endpoint = "/agents/v1/agents/spotterx/sessions";
	const response = await fetchApi(ctx, endpoint, {
		...spotterXRequestOptions(tenantId, orgId, userId),
		json: {
			user_id: userId,
			tenant_id: tenantId,
			org_id: orgId,
			saved: isSpotterChatHistoryEnabled,
			labels: { client: "mcp-server" },
			settings_override: {
				map: {
					connector_tool_approvals: false,
					enable_spotql: false,
					enable_dataset_search:
						isSpotterDataSourceDiscoveryEnabled && !dataSourceId,
				},
			},
			...(dataSourceId && { context: { dataset_ids: [dataSourceId] } }),
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"createSpotterXConversation",
			errorText,
		);
	}

	const data: any = await response.json();
	const conversationId = data?.session?.id ?? data?.id;
	if (!conversationId) {
		throw new Error("Could not extract session id from response.");
	}
	return { conversation_id: conversationId } as AgentConversation;
}

/*
 * Send a message to a SpotterX conversation, with support for a streaming response
 */
export async function sendSpotterXMessageStreaming(
	ctx: ClientContext,
	{
		tenantId,
		orgId,
		userId,
		conversationId,
		message,
		liveboardContext,
	}: {
		tenantId: string;
		orgId: string;
		userId: string;
		conversationId: string;
		message: string;
		liveboardContext?: LiveboardContext;
	},
): Promise<Response> {
	// Encoding for safety, though for valid IDs it should not make a difference
	const endpoint = `/agents/v1/agents/spotterx/sessions/${encodeURIComponent(conversationId)}/query?alt=sse`;
	const response = await fetchApi(ctx, endpoint, {
		...spotterXRequestOptions(tenantId, orgId, userId),
		accept: "text/event-stream",
		json: {
			input: { parts: [{ text_part: { text: message } }] },
			enabled_connectors: [],
			extra_headers: {
				map: {
					// API expects raw hostname (no https:// or www.)
					"x-ba-ts-host": new URL(ctx.instanceUrl).host,
				},
			},
			...(liveboardContext && {
				context_delta: {
					liveboard_in_context: true,
					liveboard_bach_session_map: {
						[liveboardContext.liveboardId]: {
							sessionId: liveboardContext.bachSession.transactionId,
							genNo: Number(liveboardContext.bachSession.generationNumber),
							answer_map: {},
						},
					},
				},
			}),
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"sendSpotterXMessageStreaming",
			errorText,
		);
	}

	return response;
}

// Artifact namespaces addressable through the agents gateway. The server takes the enum
// name, and an unspecified category silently resolves to FILES, so it is always sent
export type SpotterXArtifactCategory = "FILES" | "ASSETS";

/*
 * Fetch the content of a SpotterX session artifact as text. Artifacts are addressed by
 * session id alone, not under the /agents/spotterx prefix. The gateway answers either with
 * the raw bytes or with a JSON envelope whose `data` (or `data_b64`) is base64.
 */
export async function fetchSpotterXArtifact(
	ctx: ClientContext,
	{
		tenantId,
		orgId,
		userId,
		conversationId,
		filename,
		category,
	}: {
		tenantId: string;
		orgId: string;
		userId: string;
		conversationId: string;
		filename: string;
		category: SpotterXArtifactCategory;
	},
): Promise<string> {
	const endpoint = `/agents/v1/sessions/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(filename)}?category=${category}`;
	const response = await fetchApi(
		ctx,
		endpoint,
		spotterXRequestOptions(tenantId, orgId, userId),
	);

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"fetchSpotterXArtifact",
			errorText,
		);
	}

	if (!response.headers.get("content-type")?.includes("application/json")) {
		return await response.text();
	}
	const envelope = (await response.json()) as {
		data?: string;
		data_b64?: string;
	};
	const base64 = envelope.data_b64 ?? envelope.data;
	if (!base64) {
		throw new Error(`SpotterX artifact ${filename} has no content`);
	}
	return Buffer.from(base64, "base64").toString("utf8");
}

/*
 * Rebuild an expired SpotterX answer from its stored recipe (see fetchSpotterXArtifact).
 * Re-runs the query and returns fresh session/generation ids. On failure, the body's
 * `error_code` is WORKSHEET_NOT_FOUND when the user lost access to the data model.
 */
export async function remintSpotterXAnswer(
	ctx: ClientContext,
	{ recipe }: { recipe: unknown },
): Promise<{ sessionIdentifier: string; generationNumber: number }> {
	const response = await fetchApi(ctx, "/conversation/v2/answer/remint", {
		headers: { "x-requested-by": "ThoughtSpot" },
		json: recipe,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"remintSpotterXAnswer",
			errorText,
		);
	}

	const data = (await response.json()) as {
		session_id?: string;
		gen_no?: number;
	};
	if (!data.session_id || data.gen_no === undefined) {
		throw new Error("remintSpotterXAnswer returned no answer session");
	}
	return { sessionIdentifier: data.session_id, generationNumber: data.gen_no };
}

/*
 * Whether a remint failed because the user can no longer access the answer's data model,
 * the one remint failure the user can act on
 */
export function isRemintAccessDeniedError(error: unknown): boolean {
	if (!(error instanceof ThoughtSpotApiError) || !error.body) {
		return false;
	}
	try {
		return JSON.parse(error.body)?.error_code === "WORKSHEET_NOT_FOUND";
	} catch {
		return false;
	}
}

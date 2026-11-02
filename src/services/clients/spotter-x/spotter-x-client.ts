import type { AgentConversation } from "@thoughtspot/rest-api-sdk";
import {
	type ApiRequestOptions,
	fetchApi,
	generateRequestId,
} from "../../rest-utils";
import { type ClientContext, ThoughtSpotApiError } from "../../types";

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
		conversationId,
		message,
		tenantId,
		orgId,
		userId,
	}: {
		conversationId: string;
		message: string;
		tenantId: string;
		orgId: string;
		userId: string;
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
					"x-ba-ts-host": ctx.instanceUrl,
				},
			},
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

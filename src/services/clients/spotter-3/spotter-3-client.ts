import type { AgentConversation } from "@thoughtspot/rest-api-sdk";
import { customAlphabet } from "nanoid";
import { fetchApi } from "../../rest-utils";
import { type ClientContext, ThoughtSpotApiError } from "../../types";

/*
 * Create a Spotter3 conversation
 */
export async function createSpotter3Conversation(
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
			"createSpotter3Conversation",
			errorText,
		);
	}

	const data = (await response.json()) as AgentConversation;
	return data;
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
 * Send a message to a Spotter3 conversation, with support for a streaming response
 */
export async function sendSpotter3MessageStreaming(
	ctx: ClientContext,
	{
		conversationId,
		message,
	}: {
		conversationId: string;
		message: string;
	},
): Promise<Response> {
	// Encoding for safety, though for valid IDs it should not make a difference
	const endpoint = `/conversation/v2/${encodeURIComponent(conversationId)}/query`;
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

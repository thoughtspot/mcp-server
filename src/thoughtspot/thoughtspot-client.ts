import {
	createBearerAuthenticationConfig,
	ThoughtSpotRestApi,
} from "@thoughtspot/rest-api-sdk";
import type {
	AgentConversation,
	RequestContext,
	ResponseContext,
} from "@thoughtspot/rest-api-sdk";
import YAML from "yaml";
import { of } from "rxjs";
import type { SessionInfo } from "./types";
import { customAlphabet } from "nanoid";

/*
 * Inject custom handlers into the ThoughtSpot client
 */
export const getThoughtSpotClient = (
	instanceUrl: string,
	bearerToken: string,
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
			return of(context) as any;
		},
		post: (context: ResponseContext) => {
			return of(context) as any;
		},
	});
	const client = new ThoughtSpotRestApi(config);
	(client as any).instanceUrl = instanceUrl;
	addExportUnsavedAnswerTML(client, instanceUrl, bearerToken);
	addGetSessionInfo(client, instanceUrl, bearerToken);
	addGetAnswerSession(client, instanceUrl, bearerToken);
	addCreateAgentConversationWithAutoMode(client, instanceUrl, bearerToken);
	addSendAgentConversationMessageStreaming(client, instanceUrl, bearerToken);
	return client;
};

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
) {
	(client as any).exportUnsavedAnswerTML = async ({
		session_identifier,
		generation_number,
	}: { session_identifier: string; generation_number: number }) => {
		const endpoint = "/prism/?op=GetUnsavedAnswerTML";
		// make a graphql request to `ThoughtspotHost/prism endpoint.
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
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
) {
	(client as any).getSessionInfo = async (): Promise<SessionInfo> => {
		const endpoint = "/prism/preauth/info";
		// make a graphql request to `ThoughtspotHost/prism endpoint.
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
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
function addGetAnswerSession(client: any, instanceUrl: string, token: string) {
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
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
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
) {
	(client as any).createAgentConversationWithAutoMode = async ({
		dataSourceId,
	}: {
		dataSourceId?: string;
	}): Promise<AgentConversation> => {
		const endpoint = "/conversation/v2/";
		const fetchOptions = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
				traceparent: null,
			},
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
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
				traceparent: null,
			},
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

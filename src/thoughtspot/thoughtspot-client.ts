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
import { ORG_HEADER, buildHeaders } from "./rest-utils";
import { addSearchObjects } from "./search-objects/search-objects";
import { ORG_TOKEN_VALIDITY_SEC, fetchOrgToken } from "./token-endpoints";
import { type Org, type SessionInfo, ThoughtSpotApiError } from "./types";

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

/*
 * Inject custom handlers into the ThoughtSpot client
 */
// Per-request org selector; the access token works across all the user's orgs.
// ORG_HEADER lives in rest-utils alongside buildHeaders.

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
	addSearchObjects(client, instanceUrl, bearerToken);
	addFetchOrgBearerToken(client, instanceUrl);
	addListOrgs(client, instanceUrl, bearerToken);
	// Spotter Model (Lumos) agentic model-creation handlers.
	addMintSessionCookie(client, instanceUrl, bearerToken, orgId);
	addCreateModelSession(client, instanceUrl, bearerToken);
	addSendModelMessageStreaming(client, instanceUrl, bearerToken);
	addSaveModel(client, instanceUrl, bearerToken, orgId);
	addSaveModelViaLumos(client, instanceUrl, bearerToken);
	addFetchWorksheetModel(client, instanceUrl, bearerToken, orgId);
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
			throw new ThoughtSpotApiError(
				response.status,
				"getAnswerSession",
				errorText,
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
		isSpotterDataSourceDiscoveryEnabled,
		isSpotterChatHistoryEnabled,
		dataSourceId,
	}: {
		isSpotterDataSourceDiscoveryEnabled: boolean;
		isSpotterChatHistoryEnabled: boolean;
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
					enable_spotql: false,
					save_chat_enabled: isSpotterChatHistoryEnabled,
					enable_tool_permissions: false,
					enable_search_datasets:
						isSpotterDataSourceDiscoveryEnabled && !dataSourceId,
					enable_auto_select_dataset:
						isSpotterDataSourceDiscoveryEnabled && !dataSourceId,
					tags: ["mcp-server"],
				},
			}),
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, fetchOptions);

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
			throw new ThoughtSpotApiError(
				response.status,
				"sendAgentConversationMessageStreaming",
				errorText,
			);
		}

		return response;
	};
}

// Lists the user's orgs via the user-scoped v1 session/orgs endpoint. We avoid
// the v2 orgs/search REST endpoint because it needs ORG_ADMINISTRATION and 403s
// for regular users.
function addListOrgs(client: any, instanceUrl: string, token: string) {
	(client as any).listOrgs = async (): Promise<Org[]> => {
		const endpoint = "/callosum/v1/session/orgs?batchsize=-1&offset=-1";
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "GET",
			headers: buildHeaders(token),
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
	};
}

// Mint an org-scoped token. The endpoint path, headers, validity, and response
// shape are owned by ./token-endpoints (shared with the keep-warm DO).
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
		return fetchOrgToken({
			instanceUrl,
			bearerToken: accessToken,
			orgId,
			validityTimeInSec,
		});
	};
}

/*
 * Spotter Model (Lumos) agentic model creation.
 *
 * These call Lumos's existing tenant-edge conversation routes directly with the user's bearer
 * token: {instanceUrl}/lumos/api/v2/conversation/chat/... . The Orion `/lumos` edge authenticates
 * the token and injects the identity Lumos requires (X-ThoughtSpot-Tenant-Id/-User-Id/-Orgs).
 * No Prism proxy or public REST SDK is involved — same pattern as the Spotter 3 handlers above.
 */

const LUMOS_CONVERSATION_BASE = "/lumos/api/v2/conversation";

// Parse an array of Set-Cookie header values into a single "name=value; name=value" Cookie header,
// keeping only the name=value pair from each (dropping attributes like Path/HttpOnly/Expires).
function setCookieToCookieHeader(setCookies: Array<string | null>): string {
	const pairs: string[] = [];
	for (const sc of setCookies) {
		if (!sc) continue;
		const first = sc.split(";")[0]?.trim();
		if (first?.includes("=")) pairs.push(first);
	}
	return pairs.join("; ");
}

// Mint a ThoughtSpot session cookie (JSESSIONID) from the bearer token. The formula-validation
// backend requires a cookie session; a Bearer token alone hits a broken code path. session/login
// with the bearer token returns Set-Cookie which we fold into a Cookie header string.
function addMintSessionCookie(
	client: any,
	instanceUrl: string,
	token: string,
	orgId?: string,
) {
	(client as any).mintSessionCookie = async (): Promise<string | null> => {
		const endpoint = "/api/rest/2.0/auth/session/login";
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: buildHeaders(token, orgId),
			body: JSON.stringify({}),
		});
		const setCookies = (response.headers as any).getSetCookie?.() ?? [
			response.headers.get("set-cookie"),
		];
		const cookie = setCookieToCookieHeader(setCookies);
		if (!response.ok) {
			return null;
		}
		return cookie || null;
	};
}

// init — open a model session. Lumos opens the Bach transaction itself: on a connection for a
// brand-new model, or on an existing model when modelIdentifier is given (edit-existing).
function addCreateModelSession(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).createModelSession = async ({
		connectionIdentifier,
		modelIdentifier,
	}: {
		connectionIdentifier?: string;
		modelIdentifier?: string;
	}): Promise<{
		conversation_id: string;
		transaction_id: string;
		generation_no: number;
	}> => {
		const endpoint = `${LUMOS_CONVERSATION_BASE}/chat/init`;
		// Lumos ChatInitV2Request is strict protobuf: camelCase keys only. The model's objective is
		// conveyed by the caller's first send_model_message, not at init.
		//
		// modelIdentifier wins upstream when both are sent (the model knows its own connection), but
		// send only what applies so the intent is unambiguous in the request itself.
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: buildHeaders(token),
			body: JSON.stringify(
				modelIdentifier ? { modelIdentifier } : { connectionIdentifier },
			),
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`createModelSession failed with status ${response.status}: ${errorText}`,
			);
		}
		// Tolerate either snake_case or camelCase in the response (the V2 schema may return camelCase).
		const data = (await response.json()) as any;
		return {
			conversation_id: data.conversation_id ?? data.conversationId,
			transaction_id: data.transaction_id ?? data.transactionId,
			generation_no: data.generation_no ?? data.generationNo,
		};
	};
}

// edit — send a message; returns the raw SSE Response (caller reads the stream).
function addSendModelMessageStreaming(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).sendModelMessageStreaming = async ({
		conversation_identifier,
		transaction_id,
		generation_no,
		gen_no_working_set,
		session_cookie,
		message,
		choice,
	}: {
		conversation_identifier: string;
		transaction_id: string;
		generation_no: number;
		gen_no_working_set?: number[];
		session_cookie?: string;
		message: string;
		choice?: unknown;
	}): Promise<Response> => {
		const endpoint = `${LUMOS_CONVERSATION_BASE}/chat/${encodeURIComponent(
			conversation_identifier,
		)}/stream`;
		// Mirror the ThoughtSpot UI's /stream body exactly: camelCase keys plus
		// pinnedClientGenerationNumber (the generation working set). Backend tools like FormulaGen
		// need the pinned set to assemble the full multi-generation model; omitting it makes formula
		// validation fail even though single-generation edits (tables/columns/joins) work without it.
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: {
				...buildHeaders(token, undefined, "text/event-stream"),
				// Forward the minted session cookie so backend tools (FormulaGen validation) that
				// require a cookie session succeed.
				...(session_cookie ? { Cookie: session_cookie } : {}),
			},
			body: JSON.stringify({
				transactionId: transaction_id,
				generationNo: generation_no,
				pinnedClientGenerationNumber: gen_no_working_set ?? [],
				message,
				// Match the UI exactly: `choice` is always present (null when not answering a
				// clarification), and isRestoreRequest is always sent. Omitting these is the last
				// body-level difference from the working UI request on the formula-generation path.
				choice: choice ?? null,
				isRestoreRequest: false,
			}),
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`sendModelMessageStreaming failed with status ${response.status}: ${errorText}`,
			);
		}
		return response;
	};
}

// save (server-side) — delegate the commit to Lumos instead of driving bach from here.
//
// Lumos derives the transaction id AND the full generation working set from its own session state,
// so this path cannot under-pin: the client no longer has to accumulate generations off the SSE
// stream, where a missed event silently truncates the saved model. Selected by the
// SAVE_VIA_LUMOS flag; addSaveModel below remains the default until this is validated.
function addSaveModelViaLumos(client: any, instanceUrl: string, token: string) {
	(client as any).saveModelViaLumos = async ({
		model_session_id,
		name,
		description,
		session_cookie,
	}: {
		model_session_id: string;
		name?: string;
		description?: string;
		session_cookie?: string;
	}): Promise<{ model_identifier: string; url?: string }> => {
		const endpoint = `${LUMOS_CONVERSATION_BASE}/chat/${encodeURIComponent(
			model_session_id,
		)}/save`;
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: {
				...buildHeaders(token),
				...(session_cookie ? { Cookie: session_cookie } : {}),
			},
			// No transaction id or generation set: Lumos owns both. Sending them would only be
			// cross-checked, and a mismatch is rejected.
			body: JSON.stringify({ name, description: description ?? "" }),
		});
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(
				`saveModelViaLumos failed with status ${response.status}: ${raw}`,
			);
		}
		const parsed = JSON.parse(raw) as any;
		const guid = parsed?.model_identifier;
		if (!guid) {
			throw new Error(
				`saveModelViaLumos returned no model_identifier: ${raw.slice(0, 500)}`,
			);
		}
		return {
			model_identifier: guid,
			url: parsed.url || `${instanceUrl}/#/data/tables/${guid}`,
		};
	};
}

// Minimal bach mutation to name + persist the worksheet the model session built. We only select the
// saved worksheet header (its guid is the model id); the full client query pulls the whole model +
// fragments, which we don't need for save.
const SAVE_WORKSHEET_QUERY = `
mutation WorksheetOperation($session: BachSessionIdInput!, $baseRequests: [EditWorksheetBaseRequest!]!) {
  Worksheet__operation(session: $session, baseRequests: $baseRequests) {
    id { sessionId genNo }
    worksheetHeader { guid displayName }
  }
}`;

// save — commit the draft into a persisted worksheet/model; returns { model_identifier, url? }.
// This is a bach worksheet-editor operation (SAVE_WORKSHEET_REQUEST), NOT a Lumos conversation call:
// the model lives in the bach session identified by the conversation's transaction id, and saving it
// requires the full genNoWorkingSet (a build spans many generations). Mirrors what the ThoughtSpot
// modelling UI sends when you click Save.
function addSaveModel(
	client: any,
	instanceUrl: string,
	token: string,
	orgId?: string,
) {
	(client as any).saveModel = async ({
		transaction_id,
		generation_no,
		gen_no_working_set,
		name,
		description,
	}: {
		transaction_id: string;
		generation_no: number;
		gen_no_working_set?: number[];
		name?: string;
		description?: string;
	}): Promise<{ model_identifier: string; url?: string }> => {
		const endpoint = "/prism/?op=WorksheetOperation";
		const genNo = Number(generation_no);
		const workingSet = (
			gen_no_working_set?.length ? gen_no_working_set : [generation_no]
		).map(Number);
		// Only set name/description when a name is given. For an edit-save with no name we skip this
		// request entirely so the existing model's name AND description are preserved — sending it with
		// an undefined name and empty description would blank them.
		const baseRequests: Array<Record<string, unknown>> = [];
		if (name !== undefined) {
			baseRequests.push({
				requestType: "UPDATE_WORKSHEET_NAME_DESCRIPTION_REQUEST",
				updateWorksheetNameDescriptionTransform: {
					name,
					description: description ?? "",
				},
			});
		}
		baseRequests.push({
			requestType: "SAVE_WORKSHEET_REQUEST",
			saveWorksheetTransform: { confirmationStatus: false },
		});
		const variables = {
			session: {
				sessionId: transaction_id,
				genNo,
				genNoWorkingSet: workingSet,
			},
			baseRequests,
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: buildHeaders(token, orgId),
			body: JSON.stringify({
				operationName: "WorksheetOperation",
				query: SAVE_WORKSHEET_QUERY,
				variables,
			}),
		});
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(
				`saveModel failed with status ${response.status}: ${raw}`,
			);
		}
		const parsed = JSON.parse(raw) as any;
		// GraphQL 200s can still carry errors.
		if (parsed.errors?.length) {
			throw new Error(
				`saveModel GraphQL error: ${JSON.stringify(parsed.errors)}`,
			);
		}
		const op = parsed?.data?.Worksheet__operation;
		const guid = op?.worksheetHeader?.guid;
		if (!guid) {
			throw new Error(
				`saveModel returned no worksheet guid: ${raw.slice(0, 500)}`,
			);
		}
		return {
			model_identifier: guid,
			url: `${instanceUrl}/#/data/tables/${guid}`,
		};
	};
}

// Read the current materialized worksheet model via the bach editor — used to render an accurate,
// structured finalize summary (table/join/column counts + names) instead of parsing model-generated
// prose. Field selection is a trimmed subset of the real client's worksheetModel fragment.
const FETCH_WORKSHEET_MODEL_QUERY = `
mutation WorksheetOperation($session: BachSessionIdInput!, $baseRequests: [EditWorksheetBaseRequest!]!) {
  Worksheet__operation(session: $session, baseRequests: $baseRequests) {
    id { sessionId genNo }
    worksheetModel {
      header { guid displayName }
      columnGroup {
        schemaTableId
        header { displayName }
        worksheetColumn { header { displayName } dataType }
      }
      schemaJoins { srcSchemaTableId destSchemaTableId joinType }
      schemaGraphProto { schemaTables { schemaTableId userDefinedName } }
    }
  }
}`;

function addFetchWorksheetModel(
	client: any,
	instanceUrl: string,
	token: string,
	orgId?: string,
) {
	(client as any).fetchWorksheetModel = async ({
		session_identifier,
		generation_number,
		gen_no_working_set,
	}: {
		session_identifier: string;
		generation_number: number;
		gen_no_working_set?: number[];
	}): Promise<any> => {
		const endpoint = "/prism/?op=WorksheetOperation";
		// genNo must be a GraphQL Int; upstream sometimes hands us generation numbers as strings.
		const genNo = Number(generation_number);
		const workingSet = (
			gen_no_working_set?.length ? gen_no_working_set : [generation_number]
		).map(Number);
		const variables = {
			session: {
				sessionId: session_identifier,
				genNo,
				genNoWorkingSet: workingSet,
			},
			baseRequests: [{ requestType: "FETCH_WORKSHEET_MODEL_REQUEST" }],
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: buildHeaders(token, orgId),
			body: JSON.stringify({
				operationName: "WorksheetOperation",
				query: FETCH_WORKSHEET_MODEL_QUERY,
				variables,
			}),
		});
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(
				`fetchWorksheetModel failed with status ${response.status}: ${raw}`,
			);
		}
		return JSON.parse(raw);
	};
}

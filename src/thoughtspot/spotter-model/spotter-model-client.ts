/*
 * Spotter Model (Lumos) agentic model creation — upstream handlers.
 *
 * These call Lumos's tenant-edge conversation routes directly with the user's bearer token
 * (see LUMOS_CONVERSATION_BASE), plus the bach worksheet-editor op for the save and model fetch.
 * Same custom-handler pattern as the Spotter 3 and search_objects handlers.
 */

import { buildHeaders } from "../rest-utils";
import {
	LUMOS_CONVERSATION_BASE,
	SESSION_LOGIN_ENDPOINT,
	WORKSHEET_OPERATION_ENDPOINT,
} from "./spotter-model-constants";
import {
	FETCH_WORKSHEET_MODEL_QUERY,
	REQUEST_TYPES,
	SAVE_WORKSHEET_QUERY,
	WORKSHEET_OPERATION_NAME,
} from "./spotter-model-queries";
import type {
	CreateModelSessionParams,
	CreateModelSessionResult,
	FetchWorksheetModelParams,
	SaveModelParams,
	SaveModelResult,
	SendModelMessageParams,
} from "./spotter-model-types";

/**
 * Register every Spotter Model handler on the client.
 */
export function addSpotterModel(
	client: any,
	instanceUrl: string,
	token: string,
	orgId?: string,
) {
	addMintSessionCookie(client, instanceUrl, token, orgId);
	addCreateModelSession(client, instanceUrl, token);
	addSendModelMessageStreaming(client, instanceUrl, token);
	addSaveModel(client, instanceUrl, token, orgId);
	addFetchWorksheetModel(client, instanceUrl, token, orgId);
}

// Parse an array of Set-Cookie header values into a single "name=value; name=value" Cookie header,
// keeping only the name=value pair from each (dropping attributes like Path/HttpOnly/Expires).
export function setCookieToCookieHeader(
	setCookies: Array<string | null>,
): string {
	const pairs: string[] = [];
	for (const sc of setCookies) {
		if (!sc) continue;
		const first = sc.split(";")[0]?.trim();
		if (first?.includes("=")) pairs.push(first);
	}
	return pairs.join("; ");
}

// Build the bach session envelope both worksheet ops need. genNo must be a GraphQL Int; upstream
// sometimes hands us generation numbers as strings. An empty working set falls back to the current
// generation so the request is still valid.
function buildBachSession(
	sessionId: string,
	generation: number,
	genNoWorkingSet?: number[],
) {
	return {
		sessionId,
		genNo: Number(generation),
		genNoWorkingSet: (genNoWorkingSet?.length
			? genNoWorkingSet
			: [generation]
		).map(Number),
	};
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
		const response = await fetch(`${instanceUrl}${SESSION_LOGIN_ENDPOINT}`, {
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

// init — open a model session via Lumos's agentic entry point. Lumos opens the Bach transaction
// itself: on a connection for a new model, or on an existing model when modelIdentifier is
// given.
function addCreateModelSession(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).createModelSession = async ({
		connectionIdentifier,
		modelIdentifier,
	}: CreateModelSessionParams): Promise<CreateModelSessionResult> => {
		const endpoint = `${LUMOS_CONVERSATION_BASE}/model/init`;
		// The init request is strict protobuf: the wire keys are the proto field names
		// modelGuid/connectionGuid (camelCase) — json_format silently drops an unknown key, so a wrong
		// name leaves the field empty and surfaces as a confusing "identifier is required" 400. Send
		// only the one that applies; modelGuid wins upstream if both are sent.
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: buildHeaders(token),
			body: JSON.stringify(
				modelIdentifier
					? { modelGuid: modelIdentifier }
					: { connectionGuid: connectionIdentifier },
			),
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`createModelSession failed with status ${response.status}: ${errorText}`,
			);
		}
		// Tolerate either snake_case or camelCase in the response.
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
	}: SendModelMessageParams): Promise<Response> => {
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
	}: SaveModelParams): Promise<SaveModelResult> => {
		// Only set name/description when a name is given. For an edit-save with no name we skip this
		// request entirely so the existing model's name AND description are preserved — sending it with
		// an undefined name and empty description would blank them.
		const baseRequests: Array<Record<string, unknown>> = [];
		if (name !== undefined) {
			baseRequests.push({
				requestType: REQUEST_TYPES.updateNameDescription,
				updateWorksheetNameDescriptionTransform: {
					name,
					description: description ?? "",
				},
			});
		}
		baseRequests.push({
			requestType: REQUEST_TYPES.saveWorksheet,
			saveWorksheetTransform: { confirmationStatus: false },
		});
		const variables = {
			session: buildBachSession(
				transaction_id,
				generation_no,
				gen_no_working_set,
			),
			baseRequests,
		};
		const response = await fetch(
			`${instanceUrl}${WORKSHEET_OPERATION_ENDPOINT}`,
			{
				method: "POST",
				headers: buildHeaders(token, orgId),
				body: JSON.stringify({
					operationName: WORKSHEET_OPERATION_NAME,
					query: SAVE_WORKSHEET_QUERY,
					variables,
				}),
			},
		);
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

// Read the current materialized worksheet model, for the structured finalize summary.
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
	}: FetchWorksheetModelParams): Promise<any> => {
		const variables = {
			session: buildBachSession(
				session_identifier,
				generation_number,
				gen_no_working_set,
			),
			baseRequests: [{ requestType: REQUEST_TYPES.fetchWorksheetModel }],
		};
		const response = await fetch(
			`${instanceUrl}${WORKSHEET_OPERATION_ENDPOINT}`,
			{
				method: "POST",
				headers: buildHeaders(token, orgId),
				body: JSON.stringify({
					operationName: WORKSHEET_OPERATION_NAME,
					query: FETCH_WORKSHEET_MODEL_QUERY,
					variables,
				}),
			},
		);
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(
				`fetchWorksheetModel failed with status ${response.status}: ${raw}`,
			);
		}
		return JSON.parse(raw);
	};
}

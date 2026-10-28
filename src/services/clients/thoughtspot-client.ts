import {
	ThoughtSpotRestApi,
	createBearerAuthenticationConfig,
} from "@thoughtspot/rest-api-sdk";
import type {
	RequestContext,
	ResponseContext,
} from "@thoughtspot/rest-api-sdk";
import { of } from "rxjs";
import { ORG_HEADER, fetchApi } from "../rest-utils";
import {
	type ClientContext,
	type SessionInfo,
	ThoughtSpotApiError,
} from "../types";
import {
	exportUnsavedAnswerTML,
	getAnswerSession,
} from "./answer/answer-client";
import { getData } from "./get-data/get-data-client";
import { fetchOrgBearerToken, listOrgs } from "./orgs/orgs-client";
import { searchObjects } from "./search-objects/search-objects-client";
import {
	createAgentConversationWithAutoMode,
	streamAgentConversationMessage,
} from "./spotter-3/spotter-3-client";
import * as spotterModel from "./spotter-model/spotter-model-client";
import {
	createBachPinboardSession,
	saveBachPinboard,
} from "./spotter-viz/spotter-viz-client";

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
export type { ClientContext } from "../types";

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

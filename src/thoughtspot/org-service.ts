import type { ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk";
import type { MetricsRecorder } from "../metrics/runtime/metrics-recorder";
import {
	UPSTREAM_OPERATION_NAMES,
	observeUpstreamCall,
} from "../metrics/runtime/tool-metrics";
import { WithSpan, getActiveSpan } from "../metrics/tracing/tracing-utils";
import type { Org } from "./types";

/**
 * Org/token operations, kept separate from ThoughtSpotService (which serves
 * Spotter conversation/answer flows). Covers listing the user's orgs and minting
 * org-scoped bearer tokens — the building blocks for the multi-org (v2) tools.
 */
export class OrgService {
	constructor(
		private readonly client: ThoughtSpotRestApi,
		private readonly recorder?: MetricsRecorder,
	) {}

	/**
	 * List the orgs the authenticated user is a member of (user-scoped v1
	 * session/orgs endpoint; works for any user, unlike the admin-only orgs/search).
	 */
	@WithSpan("list-orgs")
	async listOrgs(): Promise<Org[]> {
		const orgs = (await observeUpstreamCall(
			this.recorder,
			UPSTREAM_OPERATION_NAMES.listOrgs,
			() => (this.client as any).listOrgs(),
		)) as Org[] | undefined;
		const results = orgs ?? [];
		getActiveSpan()?.setAttribute("results_count", results.length);
		return results;
	}

	/**
	 * Mint an org-scoped bearer token for `orgId`, authenticated with the given
	 * (cluster-wide) access token.
	 */
	@WithSpan("fetch-org-bearer-token")
	async fetchOrgBearerToken(
		accessToken: string,
		orgId: string,
	): Promise<string> {
		getActiveSpan()?.setAttribute("org_id", orgId);
		return (await observeUpstreamCall(
			this.recorder,
			UPSTREAM_OPERATION_NAMES.fetchOrgBearerToken,
			() => (this.client as any).fetchOrgBearerToken({ accessToken, orgId }),
		)) as string;
	}
}

import type { MetricsRecorder } from "../metrics/runtime/metrics-recorder";
import {
	UPSTREAM_OPERATION_NAMES,
	observeUpstreamCall,
} from "../metrics/runtime/tool-metrics";
import { WithSpan, getActiveSpan } from "../metrics/tracing/tracing-utils";
import type { ThoughtSpotClient } from "./clients/thoughtspot-client";
import type { Org } from "./types";

// Org/token operations, separate from ThoughtSpotService (Spotter flows): listing
// the user's orgs and minting org-scoped tokens for the multi-org (v2) tools.
export class ThoughtSpotOrgsService {
	constructor(
		private readonly client: ThoughtSpotClient,
		private readonly recorder?: MetricsRecorder,
	) {}

	// User-scoped v1 session/orgs — works for any user, unlike the admin-only orgs/search.
	@WithSpan("list-orgs")
	async listOrgs(): Promise<Org[]> {
		const orgs = (await observeUpstreamCall(
			this.recorder,
			UPSTREAM_OPERATION_NAMES.listOrgs,
			() => this.client.listOrgs(),
		)) as Org[] | undefined;
		const results = orgs ?? [];
		getActiveSpan()?.setAttribute("results_count", results.length);
		return results;
	}

	@WithSpan("fetch-org-bearer-token")
	async fetchOrgBearerToken(
		accessToken: string,
		orgId: string,
	): Promise<string> {
		getActiveSpan()?.setAttribute("org_id", orgId);
		return (await observeUpstreamCall(
			this.recorder,
			UPSTREAM_OPERATION_NAMES.fetchOrgBearerToken,
			() => this.client.fetchOrgBearerToken({ accessToken, orgId }),
		)) as string;
	}
}

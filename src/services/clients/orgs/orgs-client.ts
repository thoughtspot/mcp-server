import { fetchApi } from "../../rest-utils";
import { type ClientContext, type Org, ThoughtSpotApiError } from "../../types";
import {
	ORG_TOKEN_VALIDITY_SEC,
	fetchOrgToken,
} from "../thoughtspot-token-client";

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
// shape are owned by ../thoughtspot-token-client (shared with the keep-warm DO).
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

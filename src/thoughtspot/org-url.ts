// Org-aware ThoughtSpot UI links. API calls are org-scoped by token + header,
// but a link the user opens is resolved by the browser session's org, so the
// link itself must name the org, as ?orgId=N (blink's overrideOrgId flag).

const ORG_ID_PARAM = "orgId";

export interface OrgUrlContext {
	orgId?: string;
}

// Sets orgId in the query string before the hash, where blink reads it at boot;
// a param after the hash is part of the client route and is ignored.
const addOrgIdParam = (url: string, orgId: string): string => {
	const hashIndex = url.indexOf("#");
	const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
	const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
	const [base, query = ""] = beforeHash.split("?");
	const params = query
		.split("&")
		.filter((p) => p && !p.startsWith(`${ORG_ID_PARAM}=`));
	params.push(`${ORG_ID_PARAM}=${encodeURIComponent(orgId)}`);
	return `${base}?${params.join("&")}${hash}`;
};

export function addOrgToAppUrl(url: string, org?: OrgUrlContext): string {
	// "0" is the primary org and still a real value.
	if (org?.orgId === undefined || org.orgId === "") {
		return url;
	}
	return addOrgIdParam(url, org.orgId);
}

import { PUBLIC_ROUTES } from "@thoughtspot/mcp-auth";

const SAML_LOGIN_PATH = "/callosum/v1/saml/login";

/**
 * The auth package's POST /authorize always redirects to the cluster's SAML
 * login, even when the user already has a ThoughtSpot session. Redirect
 * straight to our /callback page (the SAML targetURLPath) instead: that page
 * fetches a token first and only falls back to SAML login if the cluster
 * returns 401.
 *
 * Any other response is returned unchanged.
 */
export function skipSamlRedirect(
	request: Request,
	response: Response,
): Response {
	const requestUrl = new URL(request.url);
	if (
		request.method !== "POST" ||
		requestUrl.pathname !== PUBLIC_ROUTES.authorize
	) {
		return response;
	}
	const location = response.headers.get("Location");
	if (!location) {
		return response;
	}

	let samlUrl: URL;
	let callbackUrl: URL;
	try {
		samlUrl = new URL(location);
		callbackUrl = new URL(samlUrl.searchParams.get("targetURLPath") ?? "");
	} catch {
		return response;
	}
	if (
		!samlUrl.pathname.endsWith(SAML_LOGIN_PATH) ||
		callbackUrl.origin !== requestUrl.origin ||
		callbackUrl.pathname !== PUBLIC_ROUTES.callback
	) {
		return response;
	}

	const headers = new Headers(response.headers);
	headers.set("Location", callbackUrl.toString());
	return new Response(null, { status: response.status, headers });
}

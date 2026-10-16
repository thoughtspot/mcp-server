import { PUBLIC_ROUTES } from "@thoughtspot/mcp-auth";

const LOGIN_PATH = "/callosum/v1/saml/login";

/**
 * The auth package's POST /authorize always redirects to the cluster's SAML
 * login, even when the user already has a ThoughtSpot session. Redirect
 * straight to our /callback page (the SAML targetURLPath) instead: that page
 * fetches a token first and only falls back to SAML login if the cluster
 * returns 401.
 *
 * Any other response is returned unchanged.
 */
export function fetchToken(request: Request, response: Response): Response {
	const requestUrl = new URL(request.url);
	if (requestUrl.pathname !== PUBLIC_ROUTES.authorize) {
		return response;
	}

	let samlUrl: URL;
	let callbackUrl: URL;
	try {
		samlUrl = new URL(response.headers.get("Location") ?? "");
		callbackUrl = new URL(samlUrl.searchParams.get("targetURLPath") ?? "");
	} catch {
		return response;
	}
	if (
		!samlUrl.pathname.endsWith(LOGIN_PATH) ||
		callbackUrl.origin !== requestUrl.origin ||
		callbackUrl.pathname !== PUBLIC_ROUTES.callback
	) {
		return response;
	}

	return Response.redirect(callbackUrl.toString(), response.status);
}

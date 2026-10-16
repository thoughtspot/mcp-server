import { buildSamlRedirectUrl } from "@thoughtspot/mcp-auth";
import { describe, expect, it } from "vitest";
import { fetchToken } from "../src/oauth-redirect";

const ORIGIN = "https://mcp.example.com";
const INSTANCE_URL = "https://acme.thoughtspot.cloud";
const OAUTH_REQ_INFO = { clientId: "client-1", scope: ["read"] };

function authorizeRequest(method = "POST", path = "/authorize") {
	return new Request(`${ORIGIN}${path}`, { method });
}

function redirectTo(location: string, status = 302) {
	return new Response(null, { status, headers: { Location: location } });
}

function samlRedirect(callbackOrigin = ORIGIN) {
	return redirectTo(
		buildSamlRedirectUrl(INSTANCE_URL, OAUTH_REQ_INFO, callbackOrigin),
	);
}

describe("fetchToken", () => {
	it("redirects POST /authorize straight to the /callback page", () => {
		const response = fetchToken(authorizeRequest(), samlRedirect());

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("Location") ?? "");
		expect(location.origin).toBe(ORIGIN);
		expect(location.pathname).toBe("/callback");
		expect(location.searchParams.get("instanceUrl")).toBe(INSTANCE_URL);
		const oauthReqInfo = JSON.parse(
			atob(
				(location.searchParams.get("oauthReqInfo") ?? "")
					.replace(/-/g, "+")
					.replace(/_/g, "/"),
			),
		);
		expect(oauthReqInfo).toEqual(OAUTH_REQ_INFO);
	});

	it("keeps the original redirect status", () => {
		const location = samlRedirect().headers.get("Location") ?? "";
		const response = fetchToken(authorizeRequest(), redirectTo(location, 303));

		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toMatch(`${ORIGIN}/callback?`);
	});

	it("leaves other paths untouched", () => {
		const original = samlRedirect();
		expect(fetchToken(authorizeRequest("POST", "/store-token"), original)).toBe(
			original,
		);
	});

	it.each([
		["a non-redirect response", new Response("error", { status: 500 })],
		[
			"a redirect that is not SAML login",
			redirectTo(`${ORIGIN}/callback?instanceUrl=x&oauthReqInfo=y`),
		],
		["an unparseable Location", redirectTo("not a url")],
		[
			"SAML login without a targetURLPath",
			redirectTo(`${INSTANCE_URL}/callosum/v1/saml/login`),
		],
		[
			"SAML login targeting another origin",
			samlRedirect("https://attacker.example.com"),
		],
		[
			"SAML login targeting another path",
			redirectTo(
				`${INSTANCE_URL}/callosum/v1/saml/login?targetURLPath=${encodeURIComponent(`${ORIGIN}/other`)}`,
			),
		],
	])("leaves %s untouched", (_name, original) => {
		expect(fetchToken(authorizeRequest(), original)).toBe(original);
	});
});

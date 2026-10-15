import { buildSamlRedirectUrl } from "@thoughtspot/mcp-auth";
import { describe, expect, it } from "vitest";
import { skipSamlRedirect } from "../src/oauth-redirect";

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

describe("skipSamlRedirect", () => {
	it("redirects POST /authorize straight to the /callback page", () => {
		const response = skipSamlRedirect(authorizeRequest(), samlRedirect());

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

	it("keeps the original status and other headers", () => {
		const original = samlRedirect();
		const headers = new Headers(original.headers);
		headers.set("X-Test", "1");
		const response = skipSamlRedirect(
			authorizeRequest(),
			new Response(null, { status: 303, headers }),
		);

		expect(response.status).toBe(303);
		expect(response.headers.get("X-Test")).toBe("1");
		expect(response.headers.get("Location")).toMatch(`${ORIGIN}/callback?`);
	});

	it.each([
		["GET /authorize", authorizeRequest("GET")],
		["POST to another path", authorizeRequest("POST", "/store-token")],
	])("leaves %s untouched", (_name, request) => {
		const original = samlRedirect();
		expect(skipSamlRedirect(request, original)).toBe(original);
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
		expect(skipSamlRedirect(authorizeRequest(), original)).toBe(original);
	});
});

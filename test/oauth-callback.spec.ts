// Runs static/oauth-callback.js (the browser script on the OAuth /callback page)
// against stubbed window, document and fetch globals. The script runs when it is
// imported, so each test re-imports it after resetting the module registry.
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://mcp.example.com";
const INSTANCE_URL = "https://acme.thoughtspot.cloud";
const FREE_TRIAL_URL = "https://team2.thoughtspot.cloud";
const OAUTH_REQ_INFO = { clientId: "client-1", scope: ["read"] };
const ENCODED_REQ_INFO = "eyJjbGllbnRJZCI6ImNsaWVudC0xIn0";
const GETTOKEN_PATH = "/callosum/v1/session/v2/gettoken";
const TOKEN = {
	token: "access-token",
	refreshToken: "refresh-token",
	tokenCreatedTime: 1000,
	tokenExpiryDuration: 2000,
};

type FakeElement = {
	style: Record<string, string>;
	textContent: string;
	value: string;
	href: string;
	target: string;
	onclick: (() => unknown) | null;
	appendChild: () => void;
	append: () => void;
};

function fakeElement(textContent = ""): FakeElement {
	return {
		style: {},
		textContent,
		value: "",
		href: "",
		target: "",
		onclick: null,
		appendChild: () => {},
		append: () => {},
	};
}

function callbackUrl(instanceUrl: string, extra: Record<string, string> = {}) {
	const url = new URL("/callback", ORIGIN);
	for (const [key, value] of Object.entries(extra)) {
		url.searchParams.set(key, value);
	}
	url.searchParams.set("instanceUrl", instanceUrl);
	url.searchParams.set("oauthReqInfo", ENCODED_REQ_INFO);
	return url.href;
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const originalFetch = globalThis.fetch;

// Let the script's async work (fetch calls, response parsing) finish.
async function settle() {
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function runCallbackPage({
	href = callbackUrl(INSTANCE_URL),
	instanceUrl = INSTANCE_URL,
	gettoken,
}: {
	href?: string;
	instanceUrl?: string;
	gettoken: () => Response | Promise<Response>;
}) {
	const elements: Record<string, FakeElement> = {
		"oauth-req-info": fakeElement(JSON.stringify(OAUTH_REQ_INFO)),
	};
	const element = (key: string) => {
		elements[key] ??= fakeElement();
		return elements[key];
	};
	const fetch = vi.fn(
		async (input: string, _init?: { credentials?: string; body?: string }) => {
			const url = new URL(input, ORIGIN);
			if (url.pathname.endsWith(GETTOKEN_PATH)) {
				return gettoken();
			}
			if (url.pathname === "/store-token") {
				return json({ redirectTo: "https://client.example.com/oauth?code=1" });
			}
			throw new Error(`Unexpected fetch: ${input}`);
		},
	);
	const location = { href, replace: vi.fn() };
	const window = { INSTANCE_URL: instanceUrl, location, history: {} };
	const document = {
		getElementById: element,
		querySelector: element,
		createElement: () => fakeElement(),
	};

	vi.stubGlobal("window", window);
	vi.stubGlobal("document", document);
	vi.stubGlobal("fetch", fetch);
	vi.resetModules();
	// @ts-expect-error -- plain browser script, no type declarations
	await import("../static/oauth-callback.js");
	await settle();

	const storeTokenCalls = fetch.mock.calls.filter(([input]) =>
		input.endsWith("/store-token"),
	);
	return { elements, fetch, location, storeTokenCalls };
}

describe("OAuth callback page", () => {
	afterEach(() => {
		vi.stubGlobal("fetch", originalFetch);
		vi.stubGlobal("window", undefined);
		vi.stubGlobal("document", undefined);
	});

	it("stores the token and returns to the client when the cluster session is valid", async () => {
		const { location, storeTokenCalls, fetch } = await runCallbackPage({
			gettoken: () => json(TOKEN),
		});

		const [gettokenUrl, gettokenInit] = fetch.mock.calls[0];
		expect(gettokenUrl).toBe(`${INSTANCE_URL}${GETTOKEN_PATH}?refresh=true`);
		expect(gettokenInit?.credentials).toBe("include");

		expect(storeTokenCalls).toHaveLength(1);
		expect(JSON.parse(storeTokenCalls[0][1]?.body as string)).toEqual({
			token: { data: TOKEN },
			oauthReqInfo: OAUTH_REQ_INFO,
			instanceUrl: INSTANCE_URL,
		});
		expect(location.href).toBe("https://client.example.com/oauth?code=1");
		expect(location.replace).not.toHaveBeenCalled();
	});

	it("goes to SAML login on the first 401, returning to /callback with the marker", async () => {
		const { location, storeTokenCalls, elements } = await runCallbackPage({
			gettoken: () => new Response("", { status: 401 }),
		});

		expect(storeTokenCalls).toHaveLength(0);
		expect(elements["manual-token-section"].style.display).toBe("none");
		expect(location.replace).toHaveBeenCalledTimes(1);

		const samlLoginUrl = new URL(location.replace.mock.calls[0][0]);
		expect(samlLoginUrl.origin + samlLoginUrl.pathname).toBe(
			`${INSTANCE_URL}/callosum/v1/saml/login`,
		);
		const target = new URL(
			samlLoginUrl.searchParams.get("targetURLPath") ?? "",
		);
		expect(target.origin + target.pathname).toBe(`${ORIGIN}/callback`);
		expect(target.searchParams.get("loginAttempted")).toBe("1");
		expect(target.searchParams.get("instanceUrl")).toBe(INSTANCE_URL);
		expect(target.searchParams.get("oauthReqInfo")).toBe(ENCODED_REQ_INFO);
	});

	it("keeps an instance URL path prefix in the SAML login URL", async () => {
		const instanceUrl = "https://acme.example.com/thoughtspot";
		const { location } = await runCallbackPage({
			href: callbackUrl(instanceUrl),
			instanceUrl,
			gettoken: () => new Response("", { status: 401 }),
		});

		const samlLoginUrl = new URL(location.replace.mock.calls[0][0]);
		expect(samlLoginUrl.pathname).toBe("/thoughtspot/callosum/v1/saml/login");
	});

	it("shows the manual token screen on a 401 after SAML login, instead of looping", async () => {
		const { location, storeTokenCalls, elements } = await runCallbackPage({
			href: callbackUrl(INSTANCE_URL, { loginAttempted: "1" }),
			gettoken: () => new Response("", { status: 401 }),
		});

		expect(location.replace).not.toHaveBeenCalled();
		expect(storeTokenCalls).toHaveLength(0);
		expect(elements["manual-token-section"].style.display).toBe("flex");
		expect(elements["manual-token-url-link"].href).toBe(
			`${INSTANCE_URL}${GETTOKEN_PATH}?refresh=true`,
		);
	});

	it("shows the free-trial message on a 401 for a free-trial cluster, without SAML login", async () => {
		const { location, elements } = await runCallbackPage({
			href: callbackUrl(FREE_TRIAL_URL),
			instanceUrl: FREE_TRIAL_URL,
			gettoken: () => new Response("", { status: 401 }),
		});

		expect(location.replace).not.toHaveBeenCalled();
		expect(elements["free-trial-error-section"].style.display).toBe("flex");
		expect(elements["manual-token-section"].style.display).toBe("none");
	});

	it("shows an error for other failed statuses, without SAML login", async () => {
		const { location, storeTokenCalls, elements } = await runCallbackPage({
			gettoken: () => new Response("boom", { status: 500 }),
		});

		expect(location.replace).not.toHaveBeenCalled();
		expect(storeTokenCalls).toHaveLength(0);
		expect(elements.h2.textContent).toBe("Authorization Failed");
		expect(elements.status.textContent).toContain("Status: 500");
	});

	it("shows an error when the token request fails, without SAML login", async () => {
		const { location, elements } = await runCallbackPage({
			gettoken: () => {
				throw new TypeError("Failed to fetch");
			},
		});

		expect(location.replace).not.toHaveBeenCalled();
		expect(elements.h2.textContent).toBe("Authorization Failed");
		expect(elements.status.textContent).toBe("Failed to fetch");
	});
});

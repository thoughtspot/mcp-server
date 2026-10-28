// Runs static/oauth-callback.js (the browser script on the OAuth /callback page)
// against stubbed window, document and fetch globals. The script runs when it is
// imported, so each test re-imports it after resetting the module registry.
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://mcp.example.com";
const INSTANCE_URL = "https://acme.thoughtspot.cloud";
const FREE_TRIAL_URL = "https://team2.thoughtspot.cloud";
const STATE_ID = "3f0c9a52-6d1e-4b7a-9c2f-8e5d4a1b7c60";
const GETTOKEN_PATH = "/callosum/v1/session/v2/gettoken";
const TOKEN = {
	token: "access-token",
	refreshToken: "refresh-token",
	tokenCreatedTime: 1000,
	// Absolute epoch-ms expiry; far in the future so the token is valid.
	tokenExpiryDuration: 4102444800000,
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

// /callback carries only the opaque state ID; the server injects the instance
// URL into the page's #oauth-flow block.
function callbackUrl() {
	const url = new URL("/callback", ORIGIN);
	url.searchParams.set("state", STATE_ID);
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
	href = callbackUrl(),
	instanceUrl = INSTANCE_URL,
	oauthFlowJson = JSON.stringify({ state: STATE_ID, instanceUrl }),
	gettoken,
	storeToken = () =>
		json({ redirectTo: "https://client.example.com/oauth?code=1" }),
}: {
	href?: string;
	instanceUrl?: string;
	oauthFlowJson?: string;
	gettoken: () => Response | Promise<Response>;
	storeToken?: () => Response | Promise<Response>;
}) {
	const elements: Record<string, FakeElement> = {
		"oauth-flow": fakeElement(oauthFlowJson),
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
				return storeToken();
			}
			throw new Error(`Unexpected fetch: ${input}`);
		},
	);
	const location = { href, replace: vi.fn() };
	const window = { location, history: {} };
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
			state: STATE_ID,
		});
		expect(location.href).toBe("https://client.example.com/oauth?code=1");
		expect(location.replace).not.toHaveBeenCalled();
	});

	it("shows the manual token screen on a 401", async () => {
		const { location, storeTokenCalls, elements } = await runCallbackPage({
			gettoken: () => new Response("", { status: 401 }),
		});

		expect(location.replace).not.toHaveBeenCalled();
		expect(storeTokenCalls).toHaveLength(0);
		expect(elements["manual-token-section"].style.display).toBe("flex");
		expect(elements["manual-token-url-link"].href).toBe(
			`${INSTANCE_URL}${GETTOKEN_PATH}?refresh=true`,
		);
	});

	it("shows the free-trial message on a 401 for a free-trial cluster", async () => {
		const { location, elements } = await runCallbackPage({
			instanceUrl: FREE_TRIAL_URL,
			gettoken: () => new Response("", { status: 401 }),
		});

		expect(location.replace).not.toHaveBeenCalled();
		expect(elements["free-trial-error-section"].style.display).toBe("flex");
		expect(elements["manual-token-section"].style.display).toBe("none");
	});

	it("shows an error for other failed statuses", async () => {
		const { location, storeTokenCalls, elements } = await runCallbackPage({
			gettoken: () => new Response("boom", { status: 500 }),
		});

		expect(location.replace).not.toHaveBeenCalled();
		expect(storeTokenCalls).toHaveLength(0);
		expect(elements.h2.textContent).toBe("Authorization Failed");
		expect(elements.status.textContent).toContain("Status: 500");
	});

	it("shows an error when the token request fails", async () => {
		const { location, elements } = await runCallbackPage({
			gettoken: () => {
				throw new TypeError("Failed to fetch");
			},
		});

		expect(location.replace).not.toHaveBeenCalled();
		expect(elements.h2.textContent).toBe("Authorization Failed");
		expect(elements.status.textContent).toBe("Failed to fetch");
	});

	it("shows an error instead of hanging when the flow block is malformed", async () => {
		const { fetch, elements } = await runCallbackPage({
			oauthFlowJson: "{{OAUTH_FLOW}}",
			gettoken: () => json(TOKEN),
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(elements.h2.textContent).toBe("Authorization Failed");
		expect(elements[".spinner"].style.display).toBe("none");
	});

	it("shows the plain-text message from a failed /store-token", async () => {
		const message =
			"This sign-in link has expired or was opened in a different browser.";
		const { location, elements } = await runCallbackPage({
			gettoken: () => json(TOKEN),
			storeToken: () => new Response(message, { status: 403 }),
		});

		expect(location.href).toBe(callbackUrl());
		expect(elements.h2.textContent).toBe("Authorization Failed");
		expect(elements.status.textContent).toBe(message);
	});

	it("shows the error field, not raw JSON, from a failed /store-token", async () => {
		const { elements } = await runCallbackPage({
			gettoken: () => json(TOKEN),
			storeToken: () => json({ error: "Token store unavailable" }, 500),
		});

		expect(elements.status.textContent).toBe("Token store unavailable");
	});
});

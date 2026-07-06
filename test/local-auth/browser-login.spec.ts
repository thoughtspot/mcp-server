import { describe, expect, it } from "vitest";
import {
	buildTokenFetchUrl,
	escapeHtml,
	extractToken,
	getBrowserCommand,
	renderInstancePage,
	renderManualPage,
} from "../../src/local-auth/browser-login-utils";

const BASE = "https://my-cluster.thoughtspot.cloud";

describe("buildTokenFetchUrl", () => {
	it("targets the token fetch endpoint with a 30-day validity", () => {
		const url = new URL(buildTokenFetchUrl(BASE));
		expect(url.origin).toBe(BASE);
		expect(url.pathname).toBe("/callosum/v1/v2/auth/token/fetch");
		expect(url.searchParams.get("validity_time_in_sec")).toBe("2592000");
	});
});

describe("extractToken", () => {
	it("reads the nested token-fetch shape", () => {
		expect(extractToken({ token: { data: { token: "abc" } } })).toBe("abc");
	});

	it("reads the flat token shape", () => {
		expect(extractToken({ token: "xyz" })).toBe("xyz");
	});

	it("returns null when there is no token", () => {
		expect(extractToken({})).toBeNull();
		expect(extractToken({ token: {} })).toBeNull();
		expect(extractToken(null)).toBeNull();
	});

	it("returns null for an empty token string", () => {
		expect(extractToken({ token: "" })).toBeNull();
	});

	it("returns null for a non-string token", () => {
		expect(extractToken({ token: { data: { token: 123 } } })).toBeNull();
	});
});

describe("getBrowserCommand", () => {
	it("uses open on macOS", () => {
		expect(getBrowserCommand("darwin", "https://x")).toEqual({
			cmd: "open",
			args: ["https://x"],
		});
	});

	it("uses cmd start on Windows", () => {
		expect(getBrowserCommand("win32", "https://x")).toEqual({
			cmd: "cmd",
			args: ["/c", "start", "", "https://x"],
		});
	});

	it("falls back to xdg-open elsewhere", () => {
		expect(getBrowserCommand("linux", "https://x")).toEqual({
			cmd: "xdg-open",
			args: ["https://x"],
		});
	});
});

describe("escapeHtml", () => {
	it("escapes HTML-significant characters", () => {
		expect(escapeHtml(`<a href="x">&'`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;&amp;&#039;",
		);
	});
});

describe("renderInstancePage", () => {
	it("prefills the cluster field from the default URL", () => {
		const html = renderInstancePage(BASE);
		expect(html).toContain(`value="${BASE}"`);
		expect(html).toContain('action="/manual"');
		expect(html).toContain('name="instanceUrl"');
	});

	it("renders an empty field when no default is given", () => {
		expect(renderInstancePage()).toContain('value=""');
	});

	it("shows an error message when provided", () => {
		expect(renderInstancePage("", "Invalid URL: bad")).toContain(
			"Invalid URL: bad",
		);
	});

	it("escapes the prefilled value to prevent attribute injection", () => {
		const html = renderInstancePage('https://x"><script>');
		expect(html).not.toContain('"><script>');
		expect(html).toContain("&quot;&gt;&lt;script&gt;");
	});

	it("embeds the per-launch nonce as a hidden form field", () => {
		const html = renderInstancePage(BASE, "", "nonce-123");
		expect(html).toContain('name="nonce" value="nonce-123"');
	});

	it("escapes the nonce to prevent attribute injection", () => {
		const html = renderInstancePage(BASE, "", '"><script>');
		expect(html).not.toContain('"><script>');
	});
});

describe("renderManualPage", () => {
	it("links to the cluster and token page and posts the pasted token", () => {
		const html = renderManualPage(BASE);
		expect(html).toContain(buildTokenFetchUrl(BASE));
		expect(html).toContain(`href="${BASE}"`);
		expect(html).toContain("/store-token");
	});

	it("sends the per-launch nonce with the stored token", () => {
		const html = renderManualPage(BASE, "nonce-123");
		expect(html).toContain('nonce: "nonce-123"');
	});
});

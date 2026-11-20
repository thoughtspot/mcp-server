import { describe, expect, it } from "vitest";
import {
	EMBED_SDK_SCRIPT_URL,
	EMBED_SDK_WIDGET_HTML,
	EMBED_TOKEN_VALIDITY_SEC,
	embedPathForRoute,
	embedSdkCsp,
} from "../../src/apps/embed-sdk-widget";

describe("embed-sdk-widget (approach B prototype)", () => {
	describe("embedPathForRoute", () => {
		it("strips the leading #/ so AppEmbed builds the same route", () => {
			expect(embedPathForRoute("#/embed/conv-assist-answer?sessionId=s")).toBe(
				"embed/conv-assist-answer?sessionId=s",
			);
			expect(embedPathForRoute("#/pinboard/abc")).toBe("pinboard/abc");
			expect(embedPathForRoute("#/home")).toBe("home");
		});
	});

	describe("embedSdkCsp", () => {
		it("declares the connected cluster's own origin, not a shared wildcard", () => {
			expect(embedSdkCsp("https://analytics.example.com/some/path")).toEqual({
				resourceDomains: ["https://cdn.jsdelivr.net"],
				connectDomains: ["https://analytics.example.com"],
				frameDomains: ["https://analytics.example.com"],
			});
		});
	});

	describe("widget HTML", () => {
		it("loads a pinned SDK build", () => {
			expect(EMBED_SDK_SCRIPT_URL).toMatch(/visual-embed-sdk@\d+\.\d+\.\d+\//);
			expect(EMBED_SDK_WIDGET_HTML).toContain(`src="${EMBED_SDK_SCRIPT_URL}"`);
		});

		it("authenticates cookieless through get_embed_token", () => {
			expect(EMBED_SDK_WIDGET_HTML).toContain("TrustedAuthTokenCookieless");
			expect(EMBED_SDK_WIDGET_HTML).toContain('name: "get_embed_token"');
		});

		it("keeps the embed token short-lived", () => {
			expect(EMBED_TOKEN_VALIDITY_SEC).toBeLessThanOrEqual(10 * 60);
		});
	});
});

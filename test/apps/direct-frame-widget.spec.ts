import { describe, expect, it } from "vitest";
import {
	DIRECT_FRAME_WIDGET_HTML,
	directFrameCsp,
	directFrameUrl,
} from "../../src/apps/direct-frame-widget";

const instance = "https://test.thoughtspot.cloud";

describe("direct-frame-widget (approach C2 prototype)", () => {
	describe("directFrameUrl", () => {
		it("frames an answer iframe_url on the instance as is", () => {
			const iframeUrl = `${instance}/?tsmcp=true#/embed/conv-assist-answer?sessionId=s&genNo=1`;
			expect(directFrameUrl(instance, iframeUrl)).toBe(iframeUrl);
		});

		it("turns an answer hash route into an instance URL", () => {
			expect(
				directFrameUrl(instance, "#/embed/conv-assist-answer?sessionId=s"),
			).toBe(`${instance}/#/embed/conv-assist-answer?sessionId=s`);
		});

		it.each([
			["the home page", "#/home"],
			["a Liveboard route", "#/pinboard/abc"],
			[
				"a Liveboard URL on the instance",
				`${instance}/#/insights/pinboard/abc`,
			],
			[
				"another origin",
				"https://evil.example.com/#/embed/conv-assist-answer?sessionId=s",
			],
			["a lookalike host", "https://test.thoughtspot.cloud.evil.com/#/home"],
			["a URL without a hash route", `${instance}/login`],
			["a javascript: URL", "javascript:alert(1)"],
			["a relative path", "/#/home"],
		])("rejects %s", (_label, target) => {
			expect(directFrameUrl(instance, target)).toBeUndefined();
		});
	});

	it("declares only the cluster as a frame domain", () => {
		expect(directFrameCsp(`${instance}/some/path`)).toEqual({
			frameDomains: [instance],
		});
	});

	it("passes no token to the frame", () => {
		// The widget calls no tools and sends the frame nothing but its URL.
		expect(DIRECT_FRAME_WIDGET_HTML).not.toMatch(
			/tools\/call|getAuthToken|Authorization|contentWindow\.postMessage/,
		);
	});
});

describe("direct-frame-widget script", () => {
	it("parses as JavaScript", () => {
		const scripts = [
			...DIRECT_FRAME_WIDGET_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g),
		].map((m) => m[1]);
		expect(scripts).toHaveLength(1);
		for (const body of scripts) {
			expect(() => new Function(body)).not.toThrow();
		}
	});
});

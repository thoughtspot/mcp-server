import { describe, expect, it } from "vitest";
import {
	MCP_VIEW_FRAME_SANDBOX,
	MCP_VIEW_PAGE_HTML,
	MCP_VIEW_WIDGET_HTML,
	VIEW_RELAY_ALLOWLIST,
	checkViewRelayRequest,
} from "../../src/apps/mcp-view-widget";
import { ApiRelayRejectedError } from "../../src/apps/thoughtspot-ui-widget";

const answerBody = JSON.stringify({
	session_identifier: "s",
	generation_number: 1,
	file_format: "CSV",
});

describe("mcp-view-widget (approach C1 prototype)", () => {
	describe("checkViewRelayRequest", () => {
		it("allows the answer CSV export", () => {
			expect(() =>
				checkViewRelayRequest({
					method: "POST",
					path: "/api/rest/2.0/report/answer",
					body: answerBody,
				}),
			).not.toThrow();
		});

		it("allows Liveboard data with only the allowed keys", () => {
			expect(() =>
				checkViewRelayRequest({
					method: "post",
					path: "/api/rest/2.0/metadata/liveboard/data",
					body: JSON.stringify({
						metadata_identifier: "lb",
						visualization_identifiers: ["v"],
						data_format: "COMPACT",
						record_offset: 0,
						record_size: 500,
					}),
				}),
			).not.toThrow();
		});

		it.each([
			["a path outside the allowlist", "POST", "/api/rest/2.0/metadata/delete"],
			["A's broad prism endpoint", "POST", "/prism/"],
			["GET on an allowed path", "GET", "/api/rest/2.0/report/answer"],
			["a query string", "POST", "/api/rest/2.0/report/answer?x=1"],
			["an encoded path", "POST", "/api/rest/2.0/report%2Fanswer"],
			["a trailing slash", "POST", "/api/rest/2.0/report/answer/"],
		])("rejects %s", (_label, method, path) => {
			expect(() =>
				checkViewRelayRequest({ method, path, body: answerBody }),
			).toThrow(ApiRelayRejectedError);
		});

		it("rejects bodies that aren't JSON objects", () => {
			for (const body of ["", "not json", "[]", "null", '"x"']) {
				expect(() =>
					checkViewRelayRequest({
						method: "POST",
						path: "/api/rest/2.0/report/answer",
						body,
					}),
				).toThrow(ApiRelayRejectedError);
			}
		});

		it("rejects body keys outside the endpoint's list", () => {
			expect(() =>
				checkViewRelayRequest({
					method: "POST",
					path: "/api/rest/2.0/metadata/answer/data",
					body: JSON.stringify({
						metadata_identifier: "a",
						runtime_filter: {},
					}),
				}),
			).toThrow(/runtime_filter/);
		});

		it("only exports answers as CSV", () => {
			expect(() =>
				checkViewRelayRequest({
					method: "POST",
					path: "/api/rest/2.0/report/answer",
					body: JSON.stringify({
						session_identifier: "s",
						generation_number: 1,
						file_format: "PDF",
					}),
				}),
			).toThrow(/CSV/);
		});

		it("lists only POST reads under the REST v2 API", () => {
			for (const entry of VIEW_RELAY_ALLOWLIST) {
				expect(entry.method).toBe("POST");
				expect(entry.path.startsWith("/api/rest/2.0/")).toBe(true);
			}
		});
	});

	describe("widget", () => {
		it("sandboxes the page without allow-same-origin", () => {
			expect(MCP_VIEW_FRAME_SANDBOX).toBe("allow-scripts");
			expect(MCP_VIEW_WIDGET_HTML).toContain('"allow-scripts"');
			expect(MCP_VIEW_WIDGET_HTML).not.toContain("allow-same-origin");
		});

		it("only forwards messages from its own page frame to the relay", () => {
			expect(MCP_VIEW_WIDGET_HTML).toContain(
				"event.source === frame.contentWindow",
			);
			expect(MCP_VIEW_WIDGET_HTML).toContain(
				'name: "thoughtspot_view_request"',
			);
		});
	});

	describe("stand-in page", () => {
		it("loads nothing external", () => {
			expect(MCP_VIEW_PAGE_HTML).not.toMatch(/<script[^>]+src=/);
			expect(MCP_VIEW_PAGE_HTML).not.toMatch(/<link[^>]+href=/);
		});

		it("never handles a nonce or token", () => {
			expect(MCP_VIEW_PAGE_HTML).not.toMatch(/nonce|token|Authorization/i);
		});
	});
});

describe("mcp-view scripts", () => {
	it.each([
		["widget", MCP_VIEW_WIDGET_HTML],
		["page", MCP_VIEW_PAGE_HTML],
	])("%s script parses as JavaScript", (_label, html) => {
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
			(m) => m[1],
		);
		expect(scripts).toHaveLength(1);
		for (const body of scripts) {
			expect(() => new Function(body)).not.toThrow();
		}
	});
});

describe("checkViewRelayRequest body", () => {
	it("returns the checked body re-serialized, collapsing duplicate keys", () => {
		const relayed = checkViewRelayRequest({
			method: "POST",
			path: "/api/rest/2.0/report/answer",
			body: '{"session_identifier":"s","generation_number":1,"file_format":"PDF","file_format":"CSV"}',
		});
		expect(JSON.parse(relayed)).toEqual({
			session_identifier: "s",
			generation_number: 1,
			file_format: "CSV",
		});
		expect(relayed).not.toContain("PDF");
	});
});

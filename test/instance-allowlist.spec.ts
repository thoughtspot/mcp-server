import { describe, expect, it, vi } from "vitest";
import {
	ALLOWLIST_MISCONFIGURED_MESSAGE,
	INSTANCE_ALLOWLIST_ENV_VAR,
	INSTANCE_NOT_PERMITTED_MESSAGE,
	InstanceAllowlistConfigError,
	checkMcpInstanceAllowed,
	getAllowedInstances,
	isInstanceAllowed,
	parseInstanceAllowlist,
	withInstanceAllowlist,
} from "../src/instance-allowlist";

const RESTRICTED_HOST = "test-champ.thoughtspot.app";
const OPEN_HOST = "test-sb.thoughtspot.app";
const CHAMPAGNE = "https://champagne.thoughtspotstaging.cloud";
const CHAMPAGNE_AWS = "https://champagne-master-aws.thoughtspotstaging.cloud";
const OTHER = "https://other.thoughtspot.cloud";

const ALLOWLIST_JSON = JSON.stringify({
	[RESTRICTED_HOST]: [CHAMPAGNE, `${CHAMPAGNE_AWS}/`],
});
const ENV = { [INSTANCE_ALLOWLIST_ENV_VAR]: ALLOWLIST_JSON };

const APPROVAL_HTML = `<!DOCTYPE html><html><head><style>.form-group input { width: 100%; }</style></head><body>
<form id="approvalForm" method="post" action="/authorize">
<label for="instanceUrl" id="instanceUrlLabel">ThoughtSpot instance URL</label>
<input type="text" id="instanceUrl" name="instanceUrl" value="" placeholder="https://your-instance.thoughtspot.cloud">
<input type="hidden" name="state" value="abc">
<div class="free-trial-footer">Don't have a ThoughtSpot instance yet?</div>
</form></body></html>`;

function htmlResponse(): Response {
	return new Response(APPROVAL_HTML, {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

function authorizePost(host: string, instanceUrl?: string): Request {
	const body = new URLSearchParams({ state: "abc" });
	if (instanceUrl !== undefined) {
		body.set("instanceUrl", instanceUrl);
	}
	return new Request(`https://${host}/authorize`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
}

const ctx = {} as ExecutionContext;

describe("parseInstanceAllowlist", () => {
	it("returns an empty map when unset or blank", () => {
		expect(parseInstanceAllowlist(undefined).size).toBe(0);
		expect(parseInstanceAllowlist("   ").size).toBe(0);
	});

	it("normalizes URLs to origins and lowercases host keys", () => {
		const allowlist = parseInstanceAllowlist(
			JSON.stringify({
				"Test-Champ.ThoughtSpot.app": [
					`${CHAMPAGNE}/`,
					"champagne-master-aws.thoughtspotstaging.cloud",
				],
			}),
		);
		expect(allowlist.get(RESTRICTED_HOST)).toEqual([CHAMPAGNE, CHAMPAGNE_AWS]);
	});

	it.each([
		["invalid JSON", "{not json"],
		["a JSON array", "[]"],
		["a non-array entry", JSON.stringify({ [RESTRICTED_HOST]: CHAMPAGNE })],
		["an empty entry", JSON.stringify({ [RESTRICTED_HOST]: [] })],
		["a non-string URL", JSON.stringify({ [RESTRICTED_HOST]: [42] })],
		["an http URL", JSON.stringify({ [RESTRICTED_HOST]: ["http://x.com"] })],
	])("throws InstanceAllowlistConfigError for %s", (_label, raw) => {
		expect(() => parseInstanceAllowlist(raw)).toThrow(
			InstanceAllowlistConfigError,
		);
	});
});

describe("parseInstanceAllowlist config shapes", () => {
	it.each([
		["a full URL", `https://${RESTRICTED_HOST}/`],
		["mixed case with port", "Test-Champ.ThoughtSpot.app:443"],
		["surrounding whitespace", `  ${RESTRICTED_HOST}  `],
	])("normalizes a host key given as %s", (_label, key) => {
		const allowlist = parseInstanceAllowlist(
			JSON.stringify({ [key]: [CHAMPAGNE] }),
		);
		expect([...allowlist.keys()]).toEqual([RESTRICTED_HOST]);
	});

	it("accepts an already-parsed object (JSON-typed Cloudflare var)", () => {
		const allowlist = parseInstanceAllowlist({
			[RESTRICTED_HOST]: [CHAMPAGNE],
		});
		expect(allowlist.get(RESTRICTED_HOST)).toEqual([CHAMPAGNE]);
	});

	it("restricts a request when the var is a JSON-typed object", () => {
		const request = new Request(`https://${RESTRICTED_HOST}/authorize`);
		expect(
			getAllowedInstances(request, {
				[INSTANCE_ALLOWLIST_ENV_VAR]: { [RESTRICTED_HOST]: [CHAMPAGNE] },
			}),
		).toEqual([CHAMPAGNE]);
	});

	it("throws a config error for an unparseable host key", () => {
		expect(() =>
			parseInstanceAllowlist(JSON.stringify({ "https://": [CHAMPAGNE] })),
		).toThrow(InstanceAllowlistConfigError);
	});
});

describe("getAllowedInstances", () => {
	it("returns the list for a restricted host", () => {
		const request = new Request(`https://${RESTRICTED_HOST}/mcp`);
		expect(getAllowedInstances(request, ENV)).toEqual([
			CHAMPAGNE,
			CHAMPAGNE_AWS,
		]);
	});

	it("returns undefined for unrestricted hosts or missing config", () => {
		expect(
			getAllowedInstances(new Request(`https://${OPEN_HOST}/mcp`), ENV),
		).toBeUndefined();
		expect(
			getAllowedInstances(new Request(`https://${RESTRICTED_HOST}/mcp`), {}),
		).toBeUndefined();
		expect(
			getAllowedInstances(
				new Request(`https://${RESTRICTED_HOST}/mcp`),
				undefined,
			),
		).toBeUndefined();
	});
});

describe("isInstanceAllowed", () => {
	const allowed = [CHAMPAGNE, CHAMPAGNE_AWS];

	it("accepts exact matches, ignoring trailing slash and path", () => {
		expect(isInstanceAllowed(CHAMPAGNE, allowed)).toBe(true);
		expect(isInstanceAllowed(`${CHAMPAGNE_AWS}/`, allowed)).toBe(true);
		expect(isInstanceAllowed(`${CHAMPAGNE}/callosum`, allowed)).toBe(true);
	});

	it.each([
		["a different instance", OTHER],
		[
			"a lookalike suffix",
			"https://champagne.thoughtspotstaging.cloud.evil.com",
		],
		["a lookalike prefix", "https://evil-champagne.thoughtspotstaging.cloud"],
		["http", "http://champagne.thoughtspotstaging.cloud"],
		["an empty value", ""],
		["undefined", undefined],
		["garbage", "https://"],
	])("rejects %s", (_label, url) => {
		expect(isInstanceAllowed(url, allowed)).toBe(false);
	});
});

describe("checkMcpInstanceAllowed", () => {
	const restrictedRequest = new Request(`https://${RESTRICTED_HOST}/mcp`);

	it("allows permitted instances on a restricted host", () => {
		expect(
			checkMcpInstanceAllowed(restrictedRequest, ENV, CHAMPAGNE),
		).toBeUndefined();
	});

	it("rejects other instances on a restricted host with 403", async () => {
		const response = checkMcpInstanceAllowed(restrictedRequest, ENV, OTHER);
		expect(response?.status).toBe(403);
		expect(await response?.text()).toBe(INSTANCE_NOT_PERMITTED_MESSAGE);
	});

	it("allows any instance on an unrestricted host", () => {
		expect(
			checkMcpInstanceAllowed(
				new Request(`https://${OPEN_HOST}/mcp`),
				ENV,
				OTHER,
			),
		).toBeUndefined();
	});

	it("fails closed with a generic 500 when config is malformed", async () => {
		const response = checkMcpInstanceAllowed(
			restrictedRequest,
			{ [INSTANCE_ALLOWLIST_ENV_VAR]: "{bad" },
			CHAMPAGNE,
		);
		expect(response?.status).toBe(500);
		expect(await response?.text()).toBe(ALLOWLIST_MISCONFIGURED_MESSAGE);
	});
});

describe("withInstanceAllowlist", () => {
	it("passes non-authorize routes straight through", async () => {
		const inner = vi.fn().mockResolvedValue(new Response("ok"));
		const request = new Request(`https://${RESTRICTED_HOST}/mcp`);

		await withInstanceAllowlist(inner)(request, ENV, ctx);

		expect(inner).toHaveBeenCalledWith(request, ENV, ctx);
	});

	it("leaves the authorize page untouched on unrestricted hosts", async () => {
		const inner = vi.fn().mockResolvedValue(htmlResponse());
		const response = await withInstanceAllowlist(inner)(
			new Request(`https://${OPEN_HOST}/authorize`),
			ENV,
			ctx,
		);
		const html = await response.text();

		expect(html).toContain('<input type="text" id="instanceUrl"');
		expect(html).not.toContain("<select");
	});

	it("renders a dropdown of only the allowed instances on restricted hosts", async () => {
		const inner = vi.fn().mockResolvedValue(htmlResponse());
		const response = await withInstanceAllowlist(inner)(
			new Request(`https://${RESTRICTED_HOST}/authorize?client_id=x`),
			ENV,
			ctx,
		);
		const html = await response.text();

		// Tooltip starts on the default (first) option so a truncated URL is readable.
		expect(html).toContain(
			`<select id="instanceUrl" name="instanceUrl" title="${CHAMPAGNE}">`,
		);
		expect(html.match(/<option /g)).toHaveLength(2);
		expect(html).toContain(
			`<option value="${CHAMPAGNE}" title="${CHAMPAGNE}">`,
		);
		expect(html).toContain(
			`<option value="${CHAMPAGNE_AWS}" title="${CHAMPAGNE_AWS}">`,
		);
		// Script keeps the tooltip in sync with the selection, appended to <body>.
		expect(html).toMatch(
			/select\.title = select\.value;[\s\S]*<\/script>\s*<\/body>/,
		);
		expect(html).not.toContain('type="text" id="instanceUrl"');
		expect(html).not.toContain('class="free-trial-footer"');
		expect(html).not.toContain("instance-select-hint");
		// The dropdown gets the same box styling as the text input it replaces.
		expect(html).toMatch(
			/<style>\s*\.form-group select \{ width: 100%;[^<]*<\/style>\s*<\/head>/,
		);
		// Hidden state input must survive the rewrite.
		expect(html).toContain('name="state" value="abc"');
	});

	it("does not rewrite non-HTML or error responses", async () => {
		const jsonResponse = new Response('{"error":"x"}', {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
		const inner = vi.fn().mockResolvedValue(jsonResponse);
		const response = await withInstanceAllowlist(inner)(
			new Request(`https://${RESTRICTED_HOST}/authorize`),
			ENV,
			ctx,
		);

		expect(response).toBe(jsonResponse);
	});

	it("forwards an allowed POST with the body intact", async () => {
		const inner = vi.fn(async (request: Request) => {
			const form = await request.formData();
			return new Response(String(form.get("instanceUrl")), { status: 302 });
		});
		const response = await withInstanceAllowlist(inner)(
			authorizePost(RESTRICTED_HOST, CHAMPAGNE_AWS),
			ENV,
			ctx,
		);

		expect(response.status).toBe(302);
		expect(await response.text()).toBe(CHAMPAGNE_AWS);
	});

	it.each([
		["a different instance", OTHER],
		["a lookalike host", "champagne.thoughtspotstaging.cloud.evil.com"],
		["a missing instance", undefined],
	])(
		"rejects a POST with %s and never calls the auth package",
		async (_label, url) => {
			const inner = vi.fn();
			const response = await withInstanceAllowlist(inner)(
				authorizePost(RESTRICTED_HOST, url),
				ENV,
				ctx,
			);

			expect(response.status).toBe(400);
			expect(await response.text()).toBe(INSTANCE_NOT_PERMITTED_MESSAGE);
			expect(inner).not.toHaveBeenCalled();
		},
	);

	it("rejects a POST whose body is not form data", async () => {
		const inner = vi.fn();
		const response = await withInstanceAllowlist(inner)(
			new Request(`https://${RESTRICTED_HOST}/authorize`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instanceUrl: CHAMPAGNE }),
			}),
			ENV,
			ctx,
		);

		expect(response.status).toBe(400);
		expect(inner).not.toHaveBeenCalled();
	});

	it("accepts any instance on POST to unrestricted hosts", async () => {
		const inner = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 302 }));
		const response = await withInstanceAllowlist(inner)(
			authorizePost(OPEN_HOST, OTHER),
			ENV,
			ctx,
		);

		expect(response.status).toBe(302);
		expect(inner).toHaveBeenCalled();
	});

	it("fails closed with a generic 500 when config is malformed", async () => {
		const inner = vi.fn();
		const response = await withInstanceAllowlist(inner)(
			new Request(`https://${OPEN_HOST}/authorize`),
			{ [INSTANCE_ALLOWLIST_ENV_VAR]: "{bad" },
			ctx,
		);

		expect(response.status).toBe(500);
		expect(await response.text()).toBe(ALLOWLIST_MISCONFIGURED_MESSAGE);
		expect(inner).not.toHaveBeenCalled();
	});
});

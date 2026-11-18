import { describe, expect, it, vi } from "vitest";
import {
	THOUGHTSPOT_UI_WIDGET_HTML,
	injectProxyScript,
	resolveThoughtSpotRoute,
	thoughtspotUiCsp,
} from "../../src/apps/thoughtspot-ui-widget";

const instanceUrl = "https://champagne.thoughtspotstaging.cloud";
const indexHtml =
	'<!DOCTYPE html>\n<html lang="en-US">\n    <head>\n        <meta charset="utf-8" />\n        <script nonce="n">var blink = {};</script>\n    </head><body></body></html>';

describe("resolveThoughtSpotRoute", () => {
	it.each([
		[undefined, "#/home"],
		["#/pinboard/abc", "#/pinboard/abc"],
		[
			`${instanceUrl}/?tsmcp=true#/embed/conv-assist-answer?sessionId=s`,
			"#/embed/conv-assist-answer?sessionId=s",
		],
		["https://evil.example.com/#/home", "#/home"],
		[`${instanceUrl}/`, "#/home"],
		["javascript:alert(1)", "#/home"],
		["not a url", "#/home"],
	])("%s → %s", (target, route) => {
		expect(resolveThoughtSpotRoute(instanceUrl, target)).toBe(route);
	});
});

describe("thoughtspotUiCsp", () => {
	it("allows the cluster and the ThoughtSpot CDNs", () => {
		const csp = thoughtspotUiCsp(`${instanceUrl}/`);
		expect(csp.connectDomains).toContain(instanceUrl);
		expect(csp.resourceDomains).toContain(instanceUrl);
		expect(csp.resourceDomains).toContain(
			"https://blink-v2-cdn.thoughtspotartifacts.cloud",
		);
	});
});

describe("injectProxyScript", () => {
	const options = {
		apiHost: `${instanceUrl}/`,
		authToken: "token-123",
		route: "#/home",
	};

	it("puts the proxy first in <head>, before any page script", () => {
		const html = injectProxyScript(indexHtml, options);
		const proxyAt = html.indexOf("[api-redirect]");
		expect(html.indexOf("<head>")).toBeLessThan(proxyAt);
		expect(proxyAt).toBeLessThan(html.indexOf("var blink"));
		expect(html).toContain(`var API_HOST = "${instanceUrl}";`);
		expect(html).toContain('var AUTH_TOKEN = "token-123";');
	});

	it("handles a <head> with attributes, and prepends when there is none", () => {
		expect(
			injectProxyScript(
				'<html><head lang="x"><title>t</title></head></html>',
				options,
			),
		).toMatch(/<head lang="x">\n<script>/);
		expect(injectProxyScript("<p>no head</p>", options)).toMatch(
			/^<script>[\s\S]*<p>no head<\/p>$/,
		);
	});

	it("escapes injected values so they cannot break out of the script", () => {
		const html = injectProxyScript(indexHtml, {
			...options,
			authToken: '"</script><script>alert(1)</script>',
			route: "#/</script>",
		});
		const proxy = html.slice(
			html.indexOf("<script>"),
			html.indexOf("var blink"),
		);
		// Only the proxy's own closing tag; the values stay inside string literals.
		expect(proxy.match(/<\/script>/g)).toHaveLength(1);
		expect(proxy).toContain(
			'var AUTH_TOKEN = "\\"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>";',
		);
	});
});

// Runs the injected proxy against a fake srcdoc window whose origin is "null",
// as it is in an opaque <iframe srcdoc>.
function bootProxy(origin: string) {
	const html = injectProxyScript(indexHtml, {
		apiHost: instanceUrl,
		authToken: "token-123",
		route: "#/pinboard/abc",
	});
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
	const fetchSpy = vi.fn().mockResolvedValue(new Response("{}"));
	const windowStub = { location: { origin, hash: "" }, fetch: fetchSpy };
	const historyStub = { replaceState: vi.fn() };
	const xhrCalls: any[] = [];
	class FakeXhr {
		withCredentials = false;
		headers: Record<string, string> = {};
		open(method: string, url: string) {
			xhrCalls.push({ method, url, xhr: this });
		}
		setRequestHeader(name: string, value: string) {
			this.headers[name] = value;
		}
		send() {}
	}
	class FakeObserver {
		observe() {}
	}
	const documentStub = {
		baseURI: "https://abc.claudemcpcontent.com/widget.html",
		currentScript: null,
		documentElement: null,
		addEventListener: () => {},
	};
	new Function(
		"window",
		"document",
		"history",
		"localStorage",
		"XMLHttpRequest",
		"MutationObserver",
		"console",
		script,
	)(
		windowStub,
		documentStub,
		historyStub,
		{ setItem: () => {} },
		FakeXhr,
		FakeObserver,
		{ log: () => {}, error: () => {} },
	);
	return { windowStub, fetchSpy, historyStub, FakeXhr, xhrCalls };
}

describe("proxy script in a null-origin srcdoc frame", () => {
	it("opens the requested route", () => {
		const { historyStub } = bootProxy("null");
		expect(historyStub.replaceState).toHaveBeenCalledWith(
			null,
			"",
			"#/pinboard/abc",
		);
	});

	it("sends relative fetches to the cluster with the bearer token, minus x-* headers", async () => {
		const { windowStub, fetchSpy } = bootProxy("null");

		await (windowStub.fetch as any)("/prism/?op=GetHome", {
			headers: { "x-requested-by": "ThoughtSpot", accept: "application/json" },
		});

		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe(`${instanceUrl}/prism/?op=GetHome`);
		expect(init.headers.get("Authorization")).toBe("Bearer token-123");
		expect(init.headers.get("x-requested-by")).toBeNull();
		expect(init.headers.get("accept")).toBe("application/json");
	});

	it("leaves absolute requests to other hosts alone", async () => {
		const { windowStub, fetchSpy } = bootProxy("null");

		await (windowStub.fetch as any)(
			"https://blink-v2-cdn.thoughtspotartifacts.cloud/x.json",
		);

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://blink-v2-cdn.thoughtspotartifacts.cloud/x.json",
			undefined,
		);
	});

	it("rewrites relative XHRs and adds the token", () => {
		const { FakeXhr, xhrCalls } = bootProxy("null");
		const xhr: any = new FakeXhr();

		xhr.open("GET", "/callosum/v1/session/info");
		xhr.setRequestHeader("X-Requested-By", "ThoughtSpot");
		xhr.send();

		expect(xhrCalls[0].url).toBe(`${instanceUrl}/callosum/v1/session/info`);
		expect(xhr.headers).toEqual({ Authorization: "Bearer token-123" });
		expect(xhr.withCredentials).toBe(true);
	});

	it("rewrites URL objects", async () => {
		const { windowStub, fetchSpy } = bootProxy("null");

		await (windowStub.fetch as any)(
			new URL("/prism/preauth/info", "https://srcdoc.invalid"),
		);

		expect(fetchSpy.mock.calls[0][0]).toBe(`${instanceUrl}/prism/preauth/info`);
	});

	it("rewrites absolute URLs built from the parent's base URL", async () => {
		const { windowStub, fetchSpy } = bootProxy("null");

		await (windowStub.fetch as any)(
			"https://abc.claudemcpcontent.com/prism/preauth/info",
		);

		expect(fetchSpy.mock.calls[0][0]).toBe(`${instanceUrl}/prism/preauth/info`);
	});

	it("also works when the frame inherits a real origin", async () => {
		const { windowStub, fetchSpy } = bootProxy(
			"https://abc.claudemcpcontent.com",
		);

		await (windowStub.fetch as any)("https://abc.claudemcpcontent.com/prism/");

		expect(fetchSpy.mock.calls[0][0]).toBe(`${instanceUrl}/prism/`);
	});
});

describe("THOUGHTSPOT_UI_WIDGET_HTML", () => {
	it("contains a syntactically valid inline script", () => {
		const match = THOUGHTSPOT_UI_WIDGET_HTML.match(
			/<script>([\s\S]*?)<\/script>/,
		);
		expect(() => new Function(match?.[1] ?? "")).not.toThrow();
	});
});

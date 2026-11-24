import { describe, expect, it, vi } from "vitest";
import {
	ApiRelayRejectedError,
	MAX_RELAY_RESPONSE_BYTES,
	RelayNonceSigner,
	THOUGHTSPOT_FRAME_SANDBOX,
	THOUGHTSPOT_FRAME_SANDBOX_SAME_ORIGIN,
	THOUGHTSPOT_UI_WIDGET_HTML,
	clientSupportsMcpApps,
	injectProxyScript,
	needsSameOriginFrame,
	relayThoughtSpotApiRequest,
	resolveRelayUrl,
	thoughtspotUiCsp,
	tryResolveThoughtSpotRoute,
} from "../../src/apps/thoughtspot-ui-widget";

const instanceUrl = "https://champagne.thoughtspotstaging.cloud";
const indexHtml =
	'<!DOCTYPE html>\n<html lang="en-US">\n    <head>\n        <meta charset="utf-8" />\n        <script nonce="n">var blink = {};</script>\n    </head><body></body></html>';

const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("clientSupportsMcpApps", () => {
	it.each([
		[undefined, false],
		[{}, false],
		[{ extensions: {} }, false],
		[{ extensions: { "io.modelcontextprotocol/ui": {} } }, false],
		[
			{
				extensions: {
					"io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] },
				},
			},
			false,
		],
		[
			{
				extensions: {
					"io.modelcontextprotocol/ui": {
						mimeTypes: ["text/html;profile=mcp-app"],
					},
				},
			},
			true,
		],
	])("%j → %s", (capabilities, expected) => {
		expect(clientSupportsMcpApps(capabilities as any)).toBe(expected);
	});
});

describe("tryResolveThoughtSpotRoute", () => {
	it.each([
		[
			`${instanceUrl}/?tsmcp=true#/embed/conv-assist-answer?sessionId=s`,
			"#/embed/conv-assist-answer?sessionId=s",
		],
		[
			"#/embed/conv-assist-answer?sessionId=s&genNo=1",
			"#/embed/conv-assist-answer?sessionId=s&genNo=1",
		],
		// Only answer embeds: Liveboards, home and other pages are refused.
		["#/home", undefined],
		["#/pinboard/abc", undefined],
		[`${instanceUrl}/#/insights/pinboard/abc`, undefined],
		["#/embed/conv-assist-answer-other?sessionId=s", undefined],
		[
			"https://evil.example.com/#/embed/conv-assist-answer?sessionId=s",
			undefined,
		],
		[`${instanceUrl}/`, undefined],
		["javascript:alert(1)", undefined],
		["not a url", undefined],
	])("%s → %s", (target, route) => {
		expect(tryResolveThoughtSpotRoute(instanceUrl, target)).toBe(route);
	});
});

describe("thoughtspotUiCsp", () => {
	it("allows cluster images and CDN assets, but no direct API calls to the cluster", () => {
		const csp = thoughtspotUiCsp(`${instanceUrl}/`);
		expect(csp.resourceDomains).toContain(instanceUrl);
		expect(csp.resourceDomains).toContain(
			"https://blink-v2-cdn.thoughtspotartifacts.cloud",
		);
		expect(csp.connectDomains).not.toContain(instanceUrl);
		expect(csp).not.toHaveProperty("frameDomains");
	});

	it("allows the hosted chart frame only with direct-chart-iframe", () => {
		expect(
			thoughtspotUiCsp(instanceUrl, { directChartIframe: true }).frameDomains,
		).toEqual(["https://*.pdom.thoughtspot.com"]);
		expect(
			thoughtspotUiCsp(instanceUrl, { inlineCharts: true }),
		).not.toHaveProperty("frameDomains");
	});
});

describe("resolveRelayUrl", () => {
	it("allows reading the cluster's static assets, but not writing to them", () => {
		const sprite =
			"/node_modules/@thoughtspot/radiant-styles/public/img/rd-icons/rd-icons-sprite/rd-icons.svg?v=1";
		expect(resolveRelayUrl(instanceUrl, sprite).pathname).toBe(
			sprite.split("?")[0],
		);
		expect(
			resolveRelayUrl(instanceUrl, "/resources/img/logo/x.svg", "HEAD")
				.pathname,
		).toBe("/resources/img/logo/x.svg");
		expect(() => resolveRelayUrl(instanceUrl, sprite, "POST")).toThrow(
			ApiRelayRejectedError,
		);
	});

	it("accepts paths on the instance", () => {
		expect(resolveRelayUrl(instanceUrl, "/prism/?op=GetHome").toString()).toBe(
			`${instanceUrl}/prism/?op=GetHome`,
		);
	});

	it.each([
		"/prism",
		"/callosum/v1/session/info",
		"/api/rest/2.0/metadata/search",
		"/",
		"/503.html",
		"/?x=1",
	])("accepts the app path %s", (path) => {
		expect(() => resolveRelayUrl(instanceUrl, path)).not.toThrow();
	});

	it.each([
		["a protocol-relative URL", "//evil.example.com/x"],
		["an absolute URL", "https://evil.example.com/x"],
		["a backslash path", "/\\evil.example.com/x"],
		["a relative path", "prism/"],
		["the v2 token endpoint", "/api/rest/2.0/auth/token/full"],
		["session login", "/callosum/v1/session/login"],
		["session logout", "/api/rest/2.0/auth/session/logout"],
		["an encoded token endpoint", "/api/rest/2.0/auth/%74oken/full"],
		["a double-encoded token endpoint", "/api/rest/2.0/auth/%2574oken/full"],
		["a path parameter", "/api/rest/2.0/auth/token;x=1/full"],
		["an encoded empty segment", "/api/rest/2.0/auth/%2Ftoken/full"],
		["an encoded dot segment", "/prism/..%2Fapi/rest/2.0/auth/token/full"],
		["an encoded backslash", "/prism/%5C..%5Cx"],
		["a malformed escape", "/prism/%E0%A4%A"],
		["force-logout", "/api/rest/2.0/users/force-logout"],
		["a password change", "/api/rest/2.0/users/change-password"],
		["an encoded control character", "/prism/%0Ax"],
		["a path outside the app's APIs", "/admin/secrets"],
		["a v1 public API outside callosum", "/tspublic/v1/user/list"],
		["a non-HTML root file", "/robots.txt"],
		["a nested HTML page", "/x/y.html"],
	])("rejects %s", (_label, path) => {
		expect(() => resolveRelayUrl(instanceUrl, path)).toThrow(
			ApiRelayRejectedError,
		);
	});
});

describe("relayThoughtSpotApiRequest", () => {
	it("calls the instance with the user's token and only safe page headers", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response('{"ok":true}', {
				status: 200,
				headers: {
					"content-type": "application/json",
					"set-cookie": "JSESSIONID=secret",
					"x-callosum-trace-id": "t1",
				},
			}),
		);

		const result = await relayThoughtSpotApiRequest(
			instanceUrl,
			"user-token",
			{
				method: "POST",
				path: "/prism/?op=GetHome",
				headers: {
					"content-type": "application/json",
					"x-requested-by": "ThoughtSpot",
					authorization: "Bearer page-supplied",
					cookie: "a=b",
					"x-forwarded-for": "1.2.3.4",
				},
				body_base64: Buffer.from('{"q":1}').toString("base64"),
			},
			fetchImpl,
		);

		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe(`${instanceUrl}/prism/?op=GetHome`);
		expect(init.method).toBe("POST");
		expect(init.redirect).toBe("manual");
		expect(init.headers.get("Authorization")).toBe("Bearer user-token");
		expect(init.headers.get("user-agent")).toBe("ThoughtSpot-ts-client");
		expect(init.headers.get("x-requested-by")).toBe("ThoughtSpot");
		expect(init.headers.get("cookie")).toBeNull();
		expect(init.headers.get("x-forwarded-for")).toBeNull();
		expect(Buffer.from(init.body).toString()).toBe('{"q":1}');

		expect(result.status).toBe(200);
		expect(result.headers).toEqual({
			"content-type": "application/json",
			"x-callosum-trace-id": "t1",
		});
		expect(Buffer.from(result.body_base64, "base64").toString()).toBe(
			'{"ok":true}',
		);
	});

	it("never forwards override or unlisted headers", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("x"));

		await relayThoughtSpotApiRequest(
			instanceUrl,
			"t",
			{
				method: "GET",
				path: "/prism/",
				headers: {
					"x-http-method-override": "DELETE",
					"x-method-override": "DELETE",
					"x-original-url": "/api/rest/2.0/auth/token/full",
					"x-rewrite-url": "/api/rest/2.0/auth/token/full",
					"x-original-method": "DELETE",
					"x-host": "evil.example.com",
					"x-real-ip": "1.2.3.4",
					"x-custom": "1",
					"x-callosum-incident-id": "i1",
					"x-apollo-operation-name": "GetHome",
				},
			},
			fetchImpl,
		);

		const headers: Headers = fetchImpl.mock.calls[0][1].headers;
		expect([...headers.keys()].sort()).toEqual([
			"authorization",
			"user-agent",
			"x-apollo-operation-name",
			"x-callosum-incident-id",
		]);
	});

	it("rejects a response whose Content-Length is over the cap without reading it", async () => {
		const response = new Response("small", {
			headers: { "content-length": String(MAX_RELAY_RESPONSE_BYTES + 1) },
		});
		const arrayBuffer = vi.spyOn(response, "arrayBuffer");

		await expect(
			relayThoughtSpotApiRequest(
				instanceUrl,
				"t",
				{ method: "GET", path: "/prism/" },
				vi.fn().mockResolvedValue(response),
			),
		).rejects.toThrow(/too large/);
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("stops reading a streamed response once it passes the cap", async () => {
		const chunk = new Uint8Array(1024 * 1024);
		let pulled = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			relayThoughtSpotApiRequest(
				instanceUrl,
				"t",
				{ method: "GET", path: "/prism/" },
				vi.fn().mockResolvedValue(new Response(body)),
			),
		).rejects.toThrow(/too large/);
		expect(cancelled).toBe(true);
		expect(pulled).toBeLessThan(20);
	});

	it("returns an empty body for HEAD, whatever its Content-Length", async () => {
		const response = new Response(null, {
			headers: { "content-length": String(MAX_RELAY_RESPONSE_BYTES + 1) },
		});

		const result = await relayThoughtSpotApiRequest(
			instanceUrl,
			"t",
			{ method: "HEAD", path: "/prism/" },
			vi.fn().mockResolvedValue(response),
		);

		expect(result.body_base64).toBe("");
	});

	it("sends no body for GET", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("x"));

		await relayThoughtSpotApiRequest(
			instanceUrl,
			"t",
			{ method: "GET", path: "/prism/", body_base64: "eA==" },
			fetchImpl,
		);

		expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
	});

	it("rejects credential endpoints without calling the instance", async () => {
		const fetchImpl = vi.fn();

		await expect(
			relayThoughtSpotApiRequest(
				instanceUrl,
				"t",
				{ method: "POST", path: "/api/rest/2.0/auth/token/full" },
				fetchImpl,
			),
		).rejects.toThrow(ApiRelayRejectedError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("RelayNonceSigner", () => {
	const secret = () => Promise.resolve("login-secret");

	it("issues unguessable signed nonces and accepts only those", async () => {
		const signer = new RelayNonceSigner(secret);
		const a = await signer.issue();
		const b = await signer.issue();

		expect(a).toMatch(/^v1\.\d+\.[\w-]{22}\.[\w-]{43}$/);
		expect(a).not.toBe(b);
		await expect(signer.isValid(a)).resolves.toBe(true);
		await expect(signer.isValid(b)).resolves.toBe(true);
		await expect(signer.isValid(undefined)).resolves.toBe(false);
		await expect(signer.isValid("")).resolves.toBe(false);
		await expect(signer.isValid("0".repeat(32))).resolves.toBe(false);
	});

	it("stays valid across signer instances with the same secret (restarts)", async () => {
		const nonce = await new RelayNonceSigner(secret).issue();

		await expect(new RelayNonceSigner(secret).isValid(nonce)).resolves.toBe(
			true,
		);
		await expect(
			new RelayNonceSigner(() => Promise.resolve("other-login")).isValid(nonce),
		).resolves.toBe(false);
	});

	it("rejects tampered and expired nonces", async () => {
		let now = 0;
		const signer = new RelayNonceSigner(secret, 1000, () => now);
		const nonce = await signer.issue();
		const [v, expiry, random, sig] = nonce.split(".");

		await expect(
			signer.isValid(
				[v, String(Number(expiry) + 10_000), random, sig].join("."),
			),
		).resolves.toBe(false);
		await expect(
			signer.isValid([v, expiry, random, `${sig.slice(0, -1)}A`].join(".")),
		).resolves.toBe(sig.endsWith("A"));

		now = 1000;
		await expect(signer.isValid(nonce)).resolves.toBe(false);
	});
});

describe("injectProxyScript", () => {
	const options = { apiHost: `${instanceUrl}/`, route: "#/home" };

	it("puts the route and proxy scripts first in <head>, with no credentials", () => {
		const html = injectProxyScript(indexHtml, options);
		const routeAt = html.indexOf('history.replaceState(null, "", "#/home")');
		const proxyAt = html.indexOf("[api-relay]");
		expect(html.indexOf("<head>")).toBeLessThan(routeAt);
		expect(routeAt).toBeLessThan(proxyAt);
		expect(proxyAt).toBeLessThan(html.indexOf("var blink"));
		expect(html).toContain(`var API_HOST = "${instanceUrl}";`);
		expect(html).not.toMatch(/AUTH_TOKEN|Bearer/);
	});

	it("leaves the chart modes off by default", () => {
		const html = injectProxyScript(indexHtml, options);
		expect(html).toContain("var INLINE_CHARTS = false;");
		expect(html).toContain("var DIRECT_CHART_IFRAME = false;");
		expect(html).not.toContain("enableHostedChartSameOriginSafari: true");
		expect(needsSameOriginFrame({})).toBe(false);
	});

	it("hides the answer's More (three-dot) menu", () => {
		const html = injectProxyScript(indexHtml, options);
		const styleAt = html.indexOf("<style>");
		expect(html.slice(styleAt)).toMatch(
			/^<style>[^<]*\[data-testid="answer-header-menu-button"\][^<]*display: none !important;/,
		);
		expect(html.indexOf("[api-relay]")).toBeLessThan(styleAt);
		expect(styleAt).toBeLessThan(html.indexOf("var blink"));
	});

	it("inline-charts also fixes the chart frame's messaging and asset lookup", () => {
		const html = injectProxyScript(indexHtml, {
			...options,
			inlineCharts: true,
		});
		// Messages to the chart: "null" targets and null host/app URLs.
		expect(html).toContain("var URL_KEYS = { hostUrl: 1, appUrl: 1 };");
		expect(html).toContain("args[0] = fixNullUrls(message, 0);");
		// The frame's window.parent keeps the transfer list and passes the
		// SDK's window check, and the frame gets the page's asset resolver.
		expect(html).toContain("if(k==='self'||k==='window')return px;");
		expect(html).toContain("return pm.apply(t,a)");
		expect(html).toContain(
			"window.__resolveAssetUrl=P.__resolveAssetUrl.bind(P)",
		);
		// All of it sits behind the flag in the shipped script.
		expect(html).toContain(
			'if (INLINE_CHARTS && window.origin && window.origin !== "null")',
		);
	});

	it("inline-charts sets the same-origin chart flag after blink.env, before </body>", () => {
		const html = injectProxyScript(
			"<html><head><script>var blink = {};</script></head><body><div></div></BODY></html>",
			{ ...options, inlineCharts: true },
		);
		const flagAt = html.indexOf("enableHostedChartSameOriginSafari: true");
		expect(html).toContain("var INLINE_CHARTS = true;");
		expect(html.indexOf("var blink")).toBeLessThan(flagAt);
		expect(flagAt).toBeLessThan(html.indexOf("</BODY>"));
		expect(
			injectProxyScript("<p>no body</p>", { ...options, inlineCharts: true }),
		).toMatch(/enableHostedChartSameOriginSafari: true[\s\S]*<\/script>$/);
		expect(needsSameOriginFrame({ inlineCharts: true })).toBe(true);
	});

	it("direct-chart-iframe turns on the hosted chart URL rewrite only", () => {
		const html = injectProxyScript(indexHtml, {
			...options,
			directChartIframe: true,
		});
		expect(html).toContain("var DIRECT_CHART_IFRAME = true;");
		expect(html).toContain("var INLINE_CHARTS = false;");
		expect(html).not.toContain("enableHostedChartSameOriginSafari: true");
		expect(needsSameOriginFrame({ directChartIframe: true })).toBe(true);
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

	it("escapes the route so it cannot break out of the script", () => {
		const html = injectProxyScript(indexHtml, {
			...options,
			route: '#/"</script><script>alert(1)</script>',
		});
		const injected = html.slice(0, html.indexOf("var blink"));
		// Only the two injected scripts' own closing tags.
		expect(injected.match(/<\/script>/g)).toHaveLength(2);
		expect(injected).toContain(
			'"#/\\"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"',
		);
	});

	it("emits scripts that compile, with no closing tag inside the proxy source", () => {
		const html = injectProxyScript(indexHtml, options);
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
			(m) => m[1],
		);
		expect(scripts).toHaveLength(2);
		for (const script of scripts) {
			expect(() => new Function(script)).not.toThrow();
		}
	});
});

// Runs the injected proxy against a fake sandboxed srcdoc window (origin "null")
// whose parent is the widget.
function bootProxy() {
	const html = injectProxyScript(indexHtml, {
		apiHost: instanceUrl,
		route: "#/home",
	});
	const proxySource = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];

	const toParent: any[] = [];
	const parentWin = { postMessage: (m: any) => toParent.push(m) };
	const listeners: ((event: any) => void)[] = [];
	const nativeFetch = vi.fn().mockResolvedValue(new Response("cdn"));
	const selfPosted: any[] = [];
	const windowStub: any = {
		location: { origin: "null", hash: "#/home" },
		parent: parentWin,
		fetch: nativeFetch,
		URL,
		// Like the native one, posts to whichever window it is called on.
		postMessage: function (this: any, ...args: any[]) {
			if (this && this !== windowStub) return this.postMessage(...args);
			selfPosted.push(args);
		},
		addEventListener: (type: string, fn: (event: any) => void) => {
			if (type === "message") listeners.push(fn);
		},
	};

	class FakeEventTarget {
		listeners: Record<string, (() => void)[]> = {};
		addEventListener(type: string, fn: () => void) {
			if (!this.listeners[type]) this.listeners[type] = [];
			this.listeners[type].push(fn);
		}
		dispatchEvent(event: Event) {
			for (const fn of this.listeners[event.type] ?? []) fn();
			const handler = (this as any)[`on${event.type}`];
			if (handler) handler();
			return true;
		}
	}
	class FakeXhr extends FakeEventTarget {
		responseType = "";
		open() {
			throw new Error("native open should not run for relayed requests");
		}
		send() {
			throw new Error("native send should not run for relayed requests");
		}
		setRequestHeader() {}
		abort() {}
	}
	class FakeElement {
		attributes: Record<string, string> = {};
		setAttribute(name: string, value: string) {
			this.attributes[name] = value;
		}
		getAttribute(name: string) {
			return this.attributes[name] ?? null;
		}
		hasAttribute(name: string) {
			return name in this.attributes;
		}
	}
	class FakeIframe extends FakeElement {
		srcdoc = "";
		nativeSrc: string | undefined;
	}
	Object.defineProperty(FakeIframe.prototype, "src", {
		configurable: true,
		get(this: FakeIframe) {
			return this.nativeSrc;
		},
		set(this: FakeIframe, value: string) {
			this.nativeSrc = value;
		},
	});
	class FakeImage extends FakeElement {}
	class FakeObserver {
		observe() {}
	}
	const documentStub = {
		baseURI: "https://abc.claudemcpcontent.com/widget.html",
		currentScript: { textContent: proxySource },
		documentElement: null,
		cookie: "",
		addEventListener: () => {},
	};
	const storage = { getItem: () => null, setItem: () => {} };
	// Reading serviceWorker throws in a sandboxed, opaque-origin frame.
	const navigatorStub = {};
	Object.defineProperty(navigatorStub, "serviceWorker", {
		configurable: true,
		get() {
			throw new Error("SecurityError: sandboxed");
		},
	});

	new Function(
		"window",
		"document",
		"history",
		"localStorage",
		"sessionStorage",
		"navigator",
		"XMLHttpRequest",
		"MutationObserver",
		"HTMLImageElement",
		"HTMLIFrameElement",
		"Element",
		"console",
		proxySource,
	)(
		windowStub,
		documentStub,
		{ replaceState: vi.fn() },
		storage,
		storage,
		navigatorStub,
		FakeXhr,
		FakeObserver,
		FakeImage,
		FakeIframe,
		FakeElement,
		{ log: () => {}, error: () => {} },
	);

	const deliver = async (data: any, source: unknown = parentWin) => {
		for (const fn of listeners) fn({ source, data });
		await settle();
	};
	const respond = (id: string, response: any) =>
		deliver({ __tsProxy: 1, kind: "response", id, response });

	return {
		windowStub,
		selfPosted,
		navigatorStub,
		toParent,
		nativeFetch,
		deliver,
		respond,
		FakeXhr,
		FakeIframe,
	};
}

const okResponse = (body: string, headers: Record<string, string> = {}) => ({
	status: 200,
	headers: { "content-type": "application/json", ...headers },
	body_base64: Buffer.from(body).toString("base64"),
});

describe("proxy script in the sandboxed srcdoc frame", () => {
	it("relays a relative fetch to the widget and returns the response", async () => {
		const { windowStub, toParent, nativeFetch, respond } = bootProxy();

		const pending = windowStub.fetch("/prism/?op=GetHome", {
			method: "POST",
			headers: { "x-requested-by": "ThoughtSpot" },
			body: '{"q":1}',
		});
		await settle();

		expect(nativeFetch).not.toHaveBeenCalled();
		const [msg] = toParent;
		expect(msg).toMatchObject({
			__tsProxy: 1,
			kind: "request",
			request: {
				method: "POST",
				path: "/prism/?op=GetHome",
				headers: { "x-requested-by": "ThoughtSpot" },
			},
		});
		expect(Buffer.from(msg.request.body_base64, "base64").toString()).toBe(
			'{"q":1}',
		);
		expect(JSON.stringify(msg)).not.toMatch(/Bearer|authorization/i);

		await respond(msg.id, okResponse('{"ok":true}'));
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("relays URL objects and absolute URLs built from the parent's base URL", async () => {
		const { windowStub, toParent } = bootProxy();

		windowStub.fetch(new URL("/prism/a", "https://srcdoc.invalid"));
		windowStub.fetch("https://abc.claudemcpcontent.com/prism/b?x=1");
		await settle();

		expect(toParent.map((m) => m.request.path)).toEqual([
			"/prism/a",
			"/prism/b?x=1",
		]);
	});

	it("maps URLs built from the null origin back to the instance", async () => {
		const { windowStub, toParent } = bootProxy();

		windowStub.fetch("null/prism/preauth/info");
		windowStub.fetch(new windowStub.URL("/prism/x", "null"));
		await settle();

		expect(toParent.map((m) => m.request.path)).toEqual([
			"/prism/preauth/info",
			"/prism/x",
		]);
	});

	it("resolves router paths against about:srcdoc instead of throwing", () => {
		const { windowStub } = bootProxy();

		const url = new windowStub.URL("/home", "about:srcdoc#/home");

		expect(url.pathname).toBe("/home");
		expect(url).toBeInstanceOf(URL);
		expect(() => new windowStub.URL("no base")).toThrow();
	});

	it("lets the page post to itself with its null origin as the target", () => {
		const { windowStub, selfPosted } = bootProxy();

		windowStub.postMessage({ a: 1 }, "null");
		windowStub.postMessage({ b: 2 }, { targetOrigin: "null" });
		windowStub.postMessage({ c: 3 }, "https://example.com");

		expect(selfPosted).toEqual([
			[{ a: 1 }, "*"],
			[{ b: 2 }, { targetOrigin: "*" }],
			[{ c: 3 }, "https://example.com"],
		]);
	});

	it("replaces navigator.serviceWorker with an inert stand-in", async () => {
		const { navigatorStub } = bootProxy();
		const sw = (navigatorStub as any).serviceWorker;

		expect(sw.controller).toBeNull();
		await expect(sw.register("/sw.js")).rejects.toThrow(/disabled/);
		await expect(sw.getRegistrations()).resolves.toEqual([]);
	});

	it("leaves requests to other hosts on the native fetch", async () => {
		const { windowStub, toParent, nativeFetch } = bootProxy();

		await windowStub.fetch(
			"https://blink-v2-cdn.thoughtspotartifacts.cloud/x.json",
		);

		expect(nativeFetch).toHaveBeenCalledTimes(1);
		expect(toParent).toHaveLength(0);
	});

	it("turns a relay error into a fetch rejection", async () => {
		const { windowStub, toParent, deliver } = bootProxy();

		const pending = windowStub.fetch("/prism/");
		await settle();
		await deliver({
			__tsProxy: 1,
			kind: "response",
			id: toParent[0].id,
			error: "nope",
		});

		await expect(pending).rejects.toThrow("nope");
	});

	it("rejects an aborted fetch with an AbortError", async () => {
		const { windowStub, toParent, respond } = bootProxy();
		const controller = new AbortController();

		const pending = windowStub.fetch("/prism/", { signal: controller.signal });
		await settle();
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await respond(toParent[0].id, okResponse("{}"));
		await expect(
			windowStub.fetch("/prism/", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("gives each document its own request ids, so a reloaded frame can't get stale answers", async () => {
		const first = bootProxy();
		const second = bootProxy();

		first.windowStub.fetch("/prism/");
		second.windowStub.fetch("/prism/");
		await settle();

		expect(first.toParent[0].id).not.toBe(second.toParent[0].id);
	});

	it("ignores a late relay answer after the XHR was opened again", async () => {
		const { toParent, respond, FakeXhr } = bootProxy();
		const xhr: any = new FakeXhr();

		xhr.open("GET", "/prism/first");
		xhr.send();
		await settle();
		xhr.open("GET", "/prism/second");

		await respond(toParent[0].id, okResponse('{"stale":true}'));
		expect(xhr.readyState).toBe(1);
		expect(xhr.status).toBeUndefined();
	});

	it("relays XHRs and fires load with the response", async () => {
		const { toParent, respond, FakeXhr } = bootProxy();
		const xhr: any = new FakeXhr();
		const onload = vi.fn();
		xhr.onload = onload;
		xhr.responseType = "json";

		xhr.open("GET", "/callosum/v1/session/info");
		xhr.setRequestHeader("X-Requested-By", "ThoughtSpot");
		xhr.send();
		await settle();

		expect(toParent[0].request).toMatchObject({
			method: "GET",
			path: "/callosum/v1/session/info",
			headers: { "x-requested-by": "ThoughtSpot" },
		});

		await respond(toParent[0].id, okResponse('{"userGUID":"u1"}'));
		expect(onload).toHaveBeenCalled();
		expect(xhr.readyState).toBe(4);
		expect(xhr.status).toBe(200);
		expect(xhr.response).toEqual({ userGUID: "u1" });
		expect(xhr.getResponseHeader("Content-Type")).toBe("application/json");
	});

	it("forwards a nested frame's request up and its response back down", async () => {
		const { windowStub, toParent, deliver, respond } = bootProxy();
		const toChild: any[] = [];
		const child = {
			parent: windowStub,
			postMessage: (m: any) => toChild.push(m),
		};

		await deliver(
			{
				__tsProxy: 1,
				kind: "request",
				id: 7,
				request: { method: "GET", path: "/prism/c", headers: {} },
			},
			child,
		);
		expect(toParent[0].request.path).toBe("/prism/c");

		await respond(toParent[0].id, okResponse("{}"));
		expect(toChild).toEqual([
			{
				__tsProxy: 1,
				kind: "response",
				id: 7,
				response: okResponse("{}"),
			},
		]);
	});

	it("ignores requests from windows that are not its child frames", async () => {
		const { toParent, deliver } = bootProxy();

		await deliver(
			{
				__tsProxy: 1,
				kind: "request",
				id: 1,
				request: { method: "GET", path: "/x", headers: {} },
			},
			{ parent: {}, postMessage: () => {} },
		);

		expect(toParent).toHaveLength(0);
	});

	it("loads a nested ThoughtSpot iframe through the relay as a sandboxed srcdoc", async () => {
		const { toParent, respond, FakeIframe } = bootProxy();
		const frame: any = new FakeIframe();

		frame.src = "/?embedApp=true#/embed/viz/abc";
		await settle();

		expect(frame.nativeSrc).toBeUndefined();
		expect(frame.attributes.sandbox).toBe("allow-scripts allow-forms");
		expect(toParent[0].request).toMatchObject({
			method: "GET",
			path: "/?embedApp=true",
		});

		await respond(
			toParent[0].id,
			okResponse("<html><head></head><body>viz</body></html>", {
				"content-type": "text/html",
			}),
		);
		expect(frame.srcdoc).toMatch(
			/^<html><head><script>try\{history\.replaceState\(null,'',"#\/embed\/viz\/abc"\)\}catch\(e\)\{\}<\/script><script>[\s\S]*\[api-relay\][\s\S]*<\/script><\/head><body>viz<\/body><\/html>$/,
		);
	});

	it("also catches nested frames set through setAttribute", async () => {
		const { toParent, FakeIframe } = bootProxy();
		const frame: any = new FakeIframe();

		frame.setAttribute("src", `${instanceUrl}/#/home`);
		await settle();

		expect(frame.attributes.src).toBeUndefined();
		expect(toParent[0].request.path).toBe("/");
	});

	it("leaves iframes to other sites alone", async () => {
		const { toParent, FakeIframe } = bootProxy();
		const frame: any = new FakeIframe();

		frame.src = "https://fast.wistia.net/embed/x";
		await settle();

		expect(frame.nativeSrc).toBe("https://fast.wistia.net/embed/x");
		expect(toParent).toHaveLength(0);
	});
});

// Runs the widget script against a fake host and DOM.
function bootWidget() {
	const script =
		THOUGHTSPOT_UI_WIDGET_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
	const toHost: any[] = [];
	const host = { postMessage: (m: any) => toHost.push(m) };
	let onMessage: (event: any) => void = () => {};
	const elements: Record<string, any> = {};
	const element = () => {
		const toPage: any[] = [];
		return {
			textContent: "",
			className: "",
			attributes: {} as Record<string, string>,
			children: [] as any[],
			toPage,
			contentWindow: { postMessage: (m: any) => toPage.push(m) },
			setAttribute(name: string, value: string) {
				this.attributes[name] = value;
			},
			replaceChildren(...nodes: any[]) {
				this.children = nodes;
			},
			addEventListener() {},
		};
	};
	const documentStub = {
		documentElement: { scrollHeight: 700 },
		body: { classList: { contains: () => false, toggle: () => {} } },
		getElementById: (id: string) => {
			if (!elements[id]) elements[id] = element();
			return elements[id];
		},
		createElement: () => element(),
	};
	new Function("window", "document", script)(
		{
			parent: host,
			// Like the native one, posts to whichever window it is called on.
			postMessage: function (this: any, ...args: any[]) {
				return this.postMessage(...args);
			},
			addEventListener: (_t: string, fn: (event: any) => void) => {
				onMessage = fn;
			},
		},
		documentStub,
	);
	const deliver = async (data: any, source: unknown = host) => {
		onMessage({ source, data });
		await settle();
	};
	return { toHost, elements, deliver };
}

describe("ThoughtSpot UI widget", () => {
	async function openPage(page: Record<string, unknown> = {}) {
		const widget = bootWidget();
		await widget.deliver({ jsonrpc: "2.0", id: 1, result: {} });
		await widget.deliver({
			jsonrpc: "2.0",
			method: "ui/notifications/tool-result",
			params: { structuredContent: { path: "#/home" } },
		});
		const pageCall = widget.toHost.at(-1);
		expect(pageCall).toMatchObject({
			method: "tools/call",
			params: { name: "get_thoughtspot_page", arguments: { path: "#/home" } },
		});
		await widget.deliver({
			jsonrpc: "2.0",
			id: pageCall.id,
			result: {
				structuredContent: {
					html: "<html>page</html>",
					relay_nonce: "nonce-1",
					...page,
				},
			},
		});
		const [iframe] = widget.elements.frame.children;
		return { ...widget, iframe };
	}

	it("loads the page into a sandboxed srcdoc frame", async () => {
		const { iframe } = await openPage();

		expect(iframe.srcdoc).toBe("<html>page</html>");
		expect(iframe.attributes.sandbox).toBe(THOUGHTSPOT_FRAME_SANDBOX);
		expect(THOUGHTSPOT_FRAME_SANDBOX).not.toMatch(/allow-same-origin/);
	});

	it("adds allow-same-origin only when the server asks for it", async () => {
		const { iframe } = await openPage({ same_origin: true });

		expect(iframe.attributes.sandbox).toBe(
			THOUGHTSPOT_FRAME_SANDBOX_SAME_ORIGIN,
		);
		expect(THOUGHTSPOT_FRAME_SANDBOX_SAME_ORIGIN).toMatch(/allow-same-origin/);
	});

	it("relays the page's API requests through thoughtspot_api_request only", async () => {
		const { iframe, toHost, deliver } = await openPage();

		await deliver(
			{
				__tsProxy: 1,
				kind: "request",
				id: 5,
				request: {
					method: "GET",
					path: "/prism/",
					headers: { accept: "*/*" },
					name: "get_answer_image",
				},
			},
			iframe.contentWindow,
		);
		const call = toHost.at(-1);
		expect(call).toMatchObject({
			method: "tools/call",
			params: {
				name: "thoughtspot_api_request",
				arguments: {
					method: "GET",
					path: "/prism/",
					headers: { accept: "*/*" },
					relay_nonce: "nonce-1",
				},
			},
		});
		expect(call.params.arguments).not.toHaveProperty("name");
		expect(iframe.srcdoc).not.toContain("nonce-1");

		const response = okResponse("{}");
		await deliver({
			jsonrpc: "2.0",
			id: call.id,
			result: { structuredContent: response },
		});
		expect(iframe.toPage).toEqual([
			{ __tsProxy: 1, kind: "response", id: 5, response },
		]);
	});

	it("ignores relay requests from anything but its page frame", async () => {
		const { toHost, deliver } = await openPage();
		const before = toHost.length;

		await deliver(
			{
				__tsProxy: 1,
				kind: "request",
				id: 1,
				request: { method: "GET", path: "/x" },
			},
			{ postMessage: () => {} },
		);

		expect(toHost).toHaveLength(before);
	});
});

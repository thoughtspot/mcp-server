// MCP Apps widget that renders the full ThoughtSpot UI inline.
//
// The server fetches the cluster's index.html, injects a proxy script at the top
// of <head>, and the widget loads the result through an <iframe srcdoc>. A srcdoc
// frame has no src URL, so the host's frameDomains restriction doesn't apply; it
// inherits the widget's CSP instead. Pages that open their own nested iframes
// still won't load.
//
// No credential ever reaches the browser. The page's same-origin API calls
// (fetch and XHR) are relayed by postMessage to the widget, which forwards them
// to the app-only thoughtspot_api_request tool; the server makes the call with
// the user's token and returns the response. This also avoids CORS, since the
// browser never calls the cluster's API directly.
//
// The srcdoc frame is sandboxed without allow-same-origin, so ThoughtSpot's
// scripts (and any third-party scripts its index.html loads) get an opaque
// origin and can't reach into the widget document or its channel to the host.
// They can only ask the widget to relay ThoughtSpot API requests.

import { MCP_APP_MIME_TYPE } from "./answer-widget";

export const THOUGHTSPOT_UI_WIDGET_URI = "ui://thoughtspot/app.html";

// MCP Apps extension id a client advertises under `capabilities.extensions`.
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/**
 * Whether the client said in `initialize` that it renders MCP App UI resources.
 * Hosts without MCP Apps ignore tool `visibility`, so app-only tools must not be
 * offered to them.
 */
export function clientSupportsMcpApps(
	capabilities: { extensions?: Record<string, unknown> } | undefined,
): boolean {
	const ui = capabilities?.extensions?.[MCP_APPS_EXTENSION_ID] as
		| { mimeTypes?: unknown }
		| undefined;
	return (
		Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(MCP_APP_MIME_TYPE)
	);
}

// Static-asset hosts the ThoughtSpot index.html loads from (scripts, styles,
// fonts, translations). Taken from the cluster's own CSP.
const THOUGHTSPOT_ASSET_ORIGINS = [
	"https://blink-v2-cdn.thoughtspotartifacts.cloud",
	"https://mfe-cdn.thoughtspot.cloud",
	"https://mfe-cdn.thoughtspotstaging.cloud",
	"https://mfe-cdn.thoughtspotdev.cloud",
	"https://fonts.gstatic.com",
];

/**
 * CSP for the widget resource. The srcdoc frame inherits it, so it must cover
 * what the ThoughtSpot UI loads directly: assets from the CDNs and images from
 * the cluster. API calls go through the server, so the cluster needs no
 * connect-src entry.
 */
export function thoughtspotUiCsp(instanceUrl: string) {
	const cluster = new URL(instanceUrl).origin;
	return {
		connectDomains: [...THOUGHTSPOT_ASSET_ORIGINS],
		resourceDomains: [cluster, ...THOUGHTSPOT_ASSET_ORIGINS],
	};
}

export const DEFAULT_THOUGHTSPOT_ROUTE = "#/home";

/**
 * Hash route to open, from either a route ("#/home", "#/pinboard/<id>") or a
 * ThoughtSpot URL on the connected instance (such as an answer's iframe_url).
 * Anything else falls back to the home page.
 */
export function resolveThoughtSpotRoute(
	instanceUrl: string,
	target: string | undefined,
): string {
	if (!target) {
		return DEFAULT_THOUGHTSPOT_ROUTE;
	}
	if (target.startsWith("#/")) {
		return target;
	}
	try {
		const url = new URL(target);
		if (
			url.origin === new URL(instanceUrl).origin &&
			url.hash.startsWith("#/")
		) {
			return url.hash;
		}
	} catch {
		// Not a URL; fall through.
	}
	return DEFAULT_THOUGHTSPOT_ROUTE;
}

// ── Server-side API relay ──────────────────────────────────────────────────

export const API_RELAY_METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
] as const;

export type ApiRelayRequest = {
	method: (typeof API_RELAY_METHODS)[number];
	path: string;
	headers?: Record<string, string>;
	body_base64?: string;
};

export type ApiRelayResponse = {
	status: number;
	headers: Record<string, string>;
	body_base64: string;
};

// Endpoints that mint, exchange or revoke credentials. Relaying them would hand
// a token to the page or end the user's session.
const DENIED_PATH =
	/\/(login|logout)(\/|$)|\/auth\/token(\/|$)|\/session\/token(\/|$)|\/auth\/session\/token(\/|$)/i;

// Largest response body relayed back to the page.
export const MAX_RELAY_RESPONSE_BYTES = 10 * 1024 * 1024;

export class ApiRelayRejectedError extends Error {}

/**
 * The cluster URL a relayed request targets. Only paths on the connected
 * instance are allowed, and never the credential endpoints.
 */
export function resolveRelayUrl(instanceUrl: string, path: string): URL {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
		throw new ApiRelayRejectedError("path must be an absolute path");
	}
	const url = new URL(path, instanceUrl);
	if (url.origin !== new URL(instanceUrl).origin) {
		throw new ApiRelayRejectedError("path must stay on the instance");
	}
	if (DENIED_PATH.test(decodeURIComponent(url.pathname))) {
		throw new ApiRelayRejectedError("credential endpoints are not relayed");
	}
	return url;
}

// Request headers the page may set. Credentials (Authorization, Cookie) and
// hop-by-hop or proxy headers are never forwarded from the page.
function isForwardableRequestHeader(name: string): boolean {
	const n = name.toLowerCase();
	if (n === "content-type" || n === "accept" || n === "accept-language") {
		return true;
	}
	return (
		n.startsWith("x-") && !n.startsWith("x-forwarded-") && n !== "x-real-ip"
	);
}

// Response headers returned to the page. Never Set-Cookie.
function isReturnableResponseHeader(name: string): boolean {
	const n = name.toLowerCase();
	return (
		n === "content-type" ||
		n === "content-disposition" ||
		n === "location" ||
		(n.startsWith("x-") && n !== "x-frame-options")
	);
}

/**
 * Make one ThoughtSpot API call on the page's behalf, with the user's token.
 * Redirects are returned, not followed, so the token never leaves the instance.
 */
export async function relayThoughtSpotApiRequest(
	instanceUrl: string,
	token: string,
	request: ApiRelayRequest,
	fetchImpl: typeof fetch = fetch,
): Promise<ApiRelayResponse> {
	const url = resolveRelayUrl(instanceUrl, request.path);
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers ?? {})) {
		if (isForwardableRequestHeader(name)) {
			headers.set(name, value);
		}
	}
	headers.set("Authorization", `Bearer ${token}`);

	const hasBody =
		request.method !== "GET" &&
		request.method !== "HEAD" &&
		request.body_base64 !== undefined;
	const response = await fetchImpl(url.toString(), {
		method: request.method,
		headers,
		body: hasBody
			? Buffer.from(request.body_base64 ?? "", "base64")
			: undefined,
		redirect: "manual",
	});

	const body = new Uint8Array(await response.arrayBuffer());
	if (body.byteLength > MAX_RELAY_RESPONSE_BYTES) {
		throw new ApiRelayRejectedError("response too large to relay");
	}
	const returned: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		if (isReturnableResponseHeader(name)) {
			returned[name] = value;
		}
	});
	return {
		status: response.status,
		headers: returned,
		body_base64: Buffer.from(body).toString("base64"),
	};
}

// ── Page proxy script ──────────────────────────────────────────────────────

// Serialize a value into an inline <script> safely: JSON-encode it, then escape
// "<" so a value can't close the script element.
function scriptLiteral(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Opens the requested page: about:srcdoc has no hash of its own. Runs before
// the proxy so the app sees the route on start.
function routeScript(route: string) {
	return `<script>
(function () {
	try {
		history.replaceState(null, "", ${scriptLiteral(route)});
	} catch (e) {
		try { window.location.hash = ${scriptLiteral(route)}; } catch (e2) {}
	}
})();
</script>`;
}

function proxyScript(apiHost: string) {
	return `<script>
// Relay the ThoughtSpot app's same-origin API calls (fetch, XHR) to the widget
// by postMessage; the MCP server makes them with the user's token. No
// credential is present in this page. Nested ThoughtSpot iframes get a copy of
// this script and relay through their parent frame.
(function () {
	// This script's own source, injected into nested frames.
	var SELF_SOURCE = (document.currentScript && document.currentScript.textContent) || "";
	var API_HOST = ${scriptLiteral(apiHost)};
	var parentWin = window.parent;
	// The sandboxed srcdoc frame has an opaque ("null") origin; new URL(x, "null")
	// throws, so resolve relative URLs against a placeholder base instead.
	var localOrigin =
		window.location.origin && window.location.origin !== "null"
			? window.location.origin
			: "https://srcdoc.invalid";
	// A srcdoc document resolves relative URLs against its parent's base URL, so
	// app code that builds absolute URLs from document.baseURI targets the
	// parent's origin. Treat that origin as local too.
	var baseOrigin = null;
	try { baseOrigin = new URL(document.baseURI).origin; } catch (e) {}
	if (baseOrigin === "null") baseOrigin = null;

	// An opaque origin has no storage or cookies, and the accessors throw.
	// Replace them with in-memory versions so the app can start.
	function memoryStorage() {
		var m = new Map();
		return {
			getItem: function (k) { k = String(k); return m.has(k) ? m.get(k) : null; },
			setItem: function (k, v) { m.set(String(k), String(v)); },
			removeItem: function (k) { m.delete(String(k)); },
			clear: function () { m.clear(); },
			key: function (i) { var keys = Array.from(m.keys()); return i < keys.length ? keys[i] : null; },
			get length() { return m.size; },
		};
	}
	["localStorage", "sessionStorage"].forEach(function (name) {
		try {
			window[name].getItem("ts-probe");
		} catch (e) {
			try { Object.defineProperty(window, name, { configurable: true, value: memoryStorage() }); } catch (e2) {}
		}
	});
	try {
		void document.cookie;
	} catch (e) {
		try {
			Object.defineProperty(document, "cookie", {
				configurable: true,
				get: function () { return ""; },
				set: function () {},
			});
		} catch (e2) {}
	}

	// Keep a service worker from intercepting requests and bypassing the relay.
	// In an opaque origin, merely reading navigator.serviceWorker throws, so
	// replace it with an inert stand-in the app can feature-detect against.
	try { localStorage.setItem("sw-disabled", "true"); } catch (e) {}
	try {
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: {
				controller: null,
				ready: new Promise(function () {}),
				register: function () {
					return Promise.reject(new Error("service workers are disabled here"));
				},
				getRegistration: function () { return Promise.resolve(undefined); },
				getRegistrations: function () { return Promise.resolve([]); },
				addEventListener: function () {},
				removeEventListener: function () {},
			},
		});
	} catch (e) {}

	// window.location.origin is "null" here, so app code that builds URLs from
	// it ("null/prism/...", new URL(path, "null")) gets invalid URLs. Map a
	// leading "null" origin to the placeholder local origin.
	function fixNullOrigin(value) {
		if (typeof value === "string" && (value === "null" || value.indexOf("null/") === 0)) {
			return localOrigin + value.slice(4);
		}
		return value;
	}
	try {
		var NativeURL = window.URL;
		var PatchedURL = function URL(url, base) {
			if (base === undefined) return new NativeURL(fixNullOrigin(url));
			var b = fixNullOrigin(String(base));
			try {
				return new NativeURL(fixNullOrigin(url), b);
			} catch (e) {
				// about:srcdoc can't be the base of a relative URL (routers resolve
				// paths against location.href); fall back to the placeholder origin.
				if (b.indexOf("about:") === 0) return new NativeURL(fixNullOrigin(url), localOrigin + "/");
				throw e;
			}
		};
		PatchedURL.prototype = NativeURL.prototype;
		Object.getOwnPropertyNames(NativeURL).forEach(function (name) {
			if (typeof NativeURL[name] === "function" && !(name in PatchedURL)) {
				PatchedURL[name] = NativeURL[name].bind(NativeURL);
			}
		});
		window.URL = PatchedURL;
	} catch (e) {}

	function shouldRewrite(url) {
		if (!url) return false;
		try {
			var origin = new URL(url, localOrigin).origin;
			return origin === localOrigin || (baseOrigin !== null && origin === baseOrigin);
		} catch (e) {
			return false;
		}
	}

	function relayPath(url) {
		var u = new URL(url, localOrigin);
		return u.pathname + u.search;
	}

	function toBase64(buffer) {
		var bytes = new Uint8Array(buffer);
		var s = "";
		for (var i = 0; i < bytes.length; i += 0x8000) {
			s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return btoa(s);
	}

	function fromBase64(b64) {
		var s = atob(b64 || "");
		var bytes = new Uint8Array(s.length);
		for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
		return bytes;
	}

	var pending = new Map();
	var nextId = 1;

	// Is this window one of our own child frames? Reading .parent is allowed on
	// cross-origin windows.
	function isChildFrame(source) {
		try { return !!source && source !== window && source.parent === window; } catch (e) { return false; }
	}

	window.addEventListener("message", function (event) {
		var msg = event.data;
		if (!msg || msg.__tsProxy !== 1) return;
		if (event.source === parentWin && msg.kind === "response") {
			var entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			if (msg.error) entry.reject(new TypeError(String(msg.error)));
			else entry.resolve(msg.response);
			return;
		}
		// A nested ThoughtSpot frame's request: pass it up and its answer back down.
		if (msg.kind === "request" && isChildFrame(event.source)) {
			var child = event.source;
			sendUp(msg.request).then(
				function (response) { child.postMessage({ __tsProxy: 1, kind: "response", id: msg.id, response: response }, "*"); },
				function (error) { child.postMessage({ __tsProxy: 1, kind: "response", id: msg.id, error: String(error && error.message || error) }, "*"); }
			);
		}
	});

	// Send one relay request to the parent frame (ultimately the widget).
	// Resolves with { status, headers, body_base64 }.
	function sendUp(request) {
		var id = nextId++;
		return new Promise(function (resolve, reject) {
			pending.set(id, { resolve: resolve, reject: reject });
			parentWin.postMessage({ __tsProxy: 1, kind: "request", id: id, request: request }, "*");
		});
	}

	function relay(method, url, headers, body) {
		var plain = {};
		headers.forEach(function (value, key) { plain[key] = value; });
		return sendUp({
			method: method,
			path: relayPath(url),
			headers: plain,
			body_base64: body && body.byteLength ? toBase64(body) : undefined,
		});
	}

	function hasNoBody(status) {
		return status === 101 || status === 204 || status === 205 || status === 304;
	}

	// Read a request body (string, FormData, Blob, ...) as bytes, along with the
	// Content-Type the browser would give it.
	function encodeBody(method, body, headers) {
		if (body == null || method === "GET" || method === "HEAD") {
			return Promise.resolve(null);
		}
		var probe = new Request("https://srcdoc.invalid/", { method: "POST", body: body });
		var type = probe.headers.get("content-type");
		if (type && !headers.has("content-type")) headers.set("content-type", type);
		return probe.arrayBuffer();
	}

	// --- Patch fetch ---
	var origFetch = window.fetch;
	if (origFetch) {
		window.fetch = function (input, init) {
			// Strings, URL objects and Request objects all name a URL.
			var isUrlLike = typeof input === "string" || input instanceof URL;
			var url = fixNullOrigin(isUrlLike ? String(input) : (input && input.url));
			if (!shouldRewrite(url)) {
				return origFetch(input, init);
			}
			var req;
			try {
				req = new Request(isUrlLike ? new URL(url, localOrigin).toString() : input, init);
			} catch (e) {
				return Promise.reject(e);
			}
			var method = req.method.toUpperCase();
			var bodyPromise = method === "GET" || method === "HEAD" ? Promise.resolve(null) : req.arrayBuffer();
			return bodyPromise
				.then(function (body) { return relay(method, url, req.headers, body); })
				.then(function (r) {
					var status = r.status >= 200 && r.status <= 599 ? r.status : 502;
					return new Response(hasNoBody(status) ? null : fromBase64(r.body_base64), {
						status: status,
						headers: r.headers || {},
					});
				});
		};
	}

	// --- Patch XMLHttpRequest ---
	// Rewritten requests never reach the network from here: send() relays them
	// and then fills in the response fields and fires the usual events.
	var xhrProto = XMLHttpRequest.prototype;
	var origOpen = xhrProto.open;
	var origSend = xhrProto.send;
	var origSetHeader = xhrProto.setRequestHeader;
	var origAbort = xhrProto.abort;
	var relayed = new WeakMap();

	function define(xhr, name, value) {
		Object.defineProperty(xhr, name, { configurable: true, writable: true, value: value });
	}

	function fire(xhr, type) {
		try { xhr.dispatchEvent(new Event(type)); } catch (e) {}
	}

	xhrProto.open = function (method, url) {
		url = fixNullOrigin(url == null ? url : String(url));
		if (shouldRewrite(url)) {
			relayed.set(this, {
				method: String(method).toUpperCase(),
				url: String(url),
				headers: new Headers(),
				aborted: false,
			});
			define(this, "readyState", 1);
			fire(this, "readystatechange");
			return;
		}
		relayed.delete(this);
		return origOpen.apply(this, arguments);
	};

	xhrProto.setRequestHeader = function (name, value) {
		var state = relayed.get(this);
		if (state) {
			state.headers.set(name, value);
			return;
		}
		return origSetHeader.apply(this, arguments);
	};

	xhrProto.abort = function () {
		var state = relayed.get(this);
		if (state) {
			state.aborted = true;
			define(this, "readyState", 4);
			define(this, "status", 0);
			fire(this, "readystatechange");
			fire(this, "abort");
			fire(this, "loadend");
			return;
		}
		return origAbort.apply(this, arguments);
	};

	xhrProto.send = function (body) {
		var state = relayed.get(this);
		if (!state) return origSend.apply(this, arguments);
		var xhr = this;
		var responseType = xhr.responseType || "";
		encodeBody(state.method, body, state.headers)
			.then(function (bytes) { return relay(state.method, state.url, state.headers, bytes); })
			.then(function (r) {
				if (state.aborted) return;
				var bytes = fromBase64(r.body_base64);
				var headers = r.headers || {};
				var text = new TextDecoder().decode(bytes);
				var response = text;
				if (responseType === "json") {
					try { response = JSON.parse(text); } catch (e) { response = null; }
				} else if (responseType === "arraybuffer") {
					response = bytes.buffer;
				} else if (responseType === "blob") {
					response = new Blob([bytes], { type: headers["content-type"] || "" });
				}
				define(xhr, "status", r.status);
				define(xhr, "statusText", "");
				define(xhr, "responseURL", API_HOST + relayPath(state.url));
				define(xhr, "response", response);
				if (responseType === "" || responseType === "text") define(xhr, "responseText", text);
				define(xhr, "getResponseHeader", function (name) {
					var v = headers[String(name).toLowerCase()];
					return v === undefined ? null : v;
				});
				define(xhr, "getAllResponseHeaders", function () {
					return Object.keys(headers).map(function (k) { return k + ": " + headers[k]; }).join("\\r\\n");
				});
				define(xhr, "readyState", 4);
				fire(xhr, "readystatechange");
				fire(xhr, "load");
				fire(xhr, "loadend");
			})
			.catch(function () {
				if (state.aborted) return;
				define(xhr, "status", 0);
				define(xhr, "readyState", 4);
				fire(xhr, "readystatechange");
				fire(xhr, "error");
				fire(xhr, "loadend");
			});
	};

	// --- Point relative <img> sources at the cluster ---
	// Images load directly (they need no credentials), so rewrite same-origin
	// image URLs to the cluster host.
	function rewriteUrl(url) {
		return API_HOST + relayPath(url) + new URL(url, localOrigin).hash;
	}

	function rewriteImg(img) {
		var src = img.getAttribute("src");
		if (src && shouldRewrite(src)) {
			img.setAttribute("src", rewriteUrl(src));
		}
		var srcset = img.getAttribute("srcset");
		if (srcset) {
			var updated = srcset.split(",").map(function (part) {
				var seg = part.trim().split(/\\s+/);
				if (seg[0] && shouldRewrite(seg[0])) {
					seg[0] = rewriteUrl(seg[0]);
				}
				return seg.join(" ");
			}).join(", ");
			if (updated !== srcset) {
				img.setAttribute("srcset", updated);
			}
		}
	}

	// <img>.src = "/x" starts the request immediately, before the observer
	// below sees the attribute, so rewrite at the property setter too.
	try {
		var srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
		if (srcDesc && srcDesc.set) {
			Object.defineProperty(HTMLImageElement.prototype, "src", {
				configurable: true,
				enumerable: srcDesc.enumerable,
				get: srcDesc.get,
				set: function (value) {
					var v = value != null && shouldRewrite(String(value)) ? rewriteUrl(String(value)) : value;
					srcDesc.set.call(this, v);
				},
			});
		}
	} catch (e) {}

	function scanForImages(root) {
		if (root.tagName === "IMG") rewriteImg(root);
		if (root.querySelectorAll) {
			root.querySelectorAll("img").forEach(rewriteImg);
		}
	}

	var imgObserver = new MutationObserver(function (mutations) {
		mutations.forEach(function (m) {
			if (m.type === "attributes" && m.target.tagName === "IMG") {
				rewriteImg(m.target);
			}
			if (m.addedNodes) {
				m.addedNodes.forEach(function (node) {
					if (node.nodeType === 1) scanForImages(node);
				});
			}
		});
	});

	if (document.documentElement) {
		imgObserver.observe(document.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["src", "srcset"],
		});
	}
	document.addEventListener("DOMContentLoaded", function () {
		scanForImages(document);
	});

	// --- Nested ThoughtSpot iframes ---
	// The host's CSP blocks nested frames that load a URL (frame-src), so a
	// ThoughtSpot iframe is loaded the same way as this page: its HTML comes
	// through the relay, gets a copy of this script, and loads as a sandboxed
	// srcdoc. srcdoc takes precedence over src, so the original src never loads.
	// Frames pointing at other sites are left alone (and stay blocked).
	var FRAME_SANDBOX = "allow-scripts allow-forms";
	var SCRIPT_OPEN = "<scr" + "ipt>";
	var SCRIPT_CLOSE = "</scr" + "ipt>";
	var frameLoads = new WeakMap();

	function frameRouteScript(hash) {
		if (!hash) return "";
		return SCRIPT_OPEN + "try{history.replaceState(null,''," +
			JSON.stringify(hash).replace(/</g, "\\\\u003c") + ")}catch(e){}" + SCRIPT_CLOSE;
	}

	function injectInto(html, hash) {
		var scripts = frameRouteScript(hash) + SCRIPT_OPEN + SELF_SOURCE + SCRIPT_CLOSE;
		var head = /<head(\\s[^>]*)?>/i.exec(html);
		if (!head) return scripts + html;
		var at = head.index + head[0].length;
		return html.slice(0, at) + scripts + html.slice(at);
	}

	function isThoughtSpotFrameUrl(url) {
		if (!url || /^(about|javascript|data|blob):/i.test(String(url))) return false;
		if (shouldRewrite(url)) return true;
		try { return new URL(url, localOrigin).origin === API_HOST; } catch (e) { return false; }
	}

	function loadNestedFrame(frame, url) {
		if (frameLoads.get(frame) === url) return;
		frameLoads.set(frame, url);
		frame.setAttribute("sandbox", FRAME_SANDBOX);
		var hash = "";
		try { hash = new URL(url, localOrigin).hash; } catch (e) {}
		relay("GET", url, new Headers({ accept: "text/html" }), null)
			.then(function (r) {
				if (frameLoads.get(frame) !== url) return;
				var html = new TextDecoder().decode(fromBase64(r.body_base64));
				frame.srcdoc = injectInto(html, hash);
			})
			.catch(function (e) {
				console.error("[api-relay] nested frame failed to load", url, e);
			});
	}

	function handleFrame(frame) {
		var src = frame.getAttribute("src");
		if (src && !frame.hasAttribute("srcdoc") && isThoughtSpotFrameUrl(src)) {
			loadNestedFrame(frame, src);
		}
	}

	try {
		var frameSrcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
		if (frameSrcDesc && frameSrcDesc.set) {
			Object.defineProperty(HTMLIFrameElement.prototype, "src", {
				configurable: true,
				enumerable: frameSrcDesc.enumerable,
				get: frameSrcDesc.get,
				set: function (value) {
					if (value != null && isThoughtSpotFrameUrl(String(value))) {
						loadNestedFrame(this, String(value));
						return;
					}
					frameSrcDesc.set.call(this, value);
				},
			});
		}
		var origSetAttribute = Element.prototype.setAttribute;
		Element.prototype.setAttribute = function (name, value) {
			if (this instanceof HTMLIFrameElement && String(name).toLowerCase() === "src" &&
				isThoughtSpotFrameUrl(String(value))) {
				loadNestedFrame(this, String(value));
				return;
			}
			return origSetAttribute.apply(this, arguments);
		};
	} catch (e) {}

	var frameObserver = new MutationObserver(function (mutations) {
		mutations.forEach(function (m) {
			m.addedNodes && m.addedNodes.forEach(function (node) {
				if (node.nodeType !== 1) return;
				if (node.tagName === "IFRAME") handleFrame(node);
				if (node.querySelectorAll) node.querySelectorAll("iframe").forEach(handleFrame);
			});
		});
	});
	if (document.documentElement) {
		frameObserver.observe(document.documentElement, { subtree: true, childList: true });
	}

	console.log("[api-relay] Relaying same-origin API calls to " + API_HOST + " through the MCP server");
})();
</script>`;
}

/**
 * The cluster's index.html with the proxy script injected as the first element
 * of <head>, so it patches fetch/XHR before any ThoughtSpot script runs. The
 * result carries no credentials.
 */
export function injectProxyScript(
	indexHtml: string,
	{ apiHost, route }: { apiHost: string; route: string },
): string {
	const script = routeScript(route) + proxyScript(new URL(apiHost).origin);
	const head = /<head(\s[^>]*)?>/i.exec(indexHtml);
	if (!head) {
		return script + indexHtml;
	}
	const at = head.index + head[0].length;
	return `${indexHtml.slice(0, at)}\n${script}${indexHtml.slice(at)}`;
}

// ── Widget ─────────────────────────────────────────────────────────────────

// Protocol version the widget announces in ui/initialize (LATEST_PROTOCOL_VERSION in ext-apps).
const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

// Sandbox for the srcdoc frame: scripts run, but without allow-same-origin the
// page gets an opaque origin and can't touch the widget.
export const THOUGHTSPOT_FRAME_SANDBOX = "allow-scripts allow-forms";

export const THOUGHTSPOT_UI_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
	* { box-sizing: border-box; }
	html, body { margin: 0; background: transparent; color: #6b7280;
		font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
	.bar { display: flex; justify-content: flex-end; padding: 4px 0; }
	button { font: inherit; border: 0; border-radius: 6px; padding: 4px 10px;
		background: #2770ef; color: #fff; cursor: pointer; }
	iframe { display: block; width: 100%; height: 640px; border: 1px solid #e5e7eb;
		border-radius: 8px; background: #fff; }
	body.fullscreen iframe { height: calc(100vh - 40px); }
	.status { padding: 24px; text-align: center; }
	.status.error { color: #b42318; }
</style>
</head>
<body>
<div class="bar"><button id="expand" type="button">Expand</button></div>
<div id="frame"><div class="status">Loading ThoughtSpot…</div></div>
<script>
(() => {
	const parent = window.parent;
	const pending = new Map();
	let nextId = 1;
	let currentPath;
	let pageFrame;

	const frameEl = document.getElementById("frame");
	const expandEl = document.getElementById("expand");

	function send(message) {
		parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
	}

	function request(method, params) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			send({ id, method, params });
		});
	}

	function notify(method, params) {
		send({ method, params });
	}

	function reportSize() {
		notify("ui/notifications/size-changed", {
			height: Math.ceil(document.documentElement.scrollHeight),
		});
	}

	function showStatus(text, isError) {
		pageFrame = undefined;
		const el = document.createElement("div");
		el.className = isError ? "status error" : "status";
		el.textContent = text;
		frameEl.replaceChildren(el);
		reportSize();
	}

	async function load(path) {
		currentPath = path;
		showStatus("Loading ThoughtSpot…");
		try {
			const result = await request("tools/call", {
				name: "get_thoughtspot_page",
				arguments: { path },
			});
			if (currentPath !== path) return;
			const text = (result.content || []).find((c) => c.type === "text");
			const page = result.structuredContent;
			if (result.isError || !page || !page.html) {
				showStatus(text ? text.text : "Could not load ThoughtSpot.", true);
				return;
			}
			const iframe = document.createElement("iframe");
			iframe.title = "ThoughtSpot";
			iframe.setAttribute("sandbox", "${THOUGHTSPOT_FRAME_SANDBOX}");
			iframe.srcdoc = page.html;
			frameEl.replaceChildren(iframe);
			pageFrame = iframe;
			reportSize();
		} catch (error) {
			if (currentPath !== path) return;
			showStatus("Could not load ThoughtSpot.", true);
		}
	}

	// Relay one API request from the ThoughtSpot page to the server. The page can
	// only reach thoughtspot_api_request; it never gets any other tool.
	async function relayPageRequest(source, msg) {
		const reply = (body) =>
			source.postMessage({ __tsProxy: 1, kind: "response", id: msg.id, ...body }, "*");
		const req = msg.request;
		if (!req || typeof req.method !== "string" || typeof req.path !== "string") {
			reply({ error: "invalid request" });
			return;
		}
		try {
			const result = await request("tools/call", {
				name: "thoughtspot_api_request",
				arguments: {
					method: req.method,
					path: req.path,
					headers: req.headers || {},
					...(typeof req.body_base64 === "string" && { body_base64: req.body_base64 }),
				},
			});
			if (result.isError || !result.structuredContent) {
				const text = (result.content || []).find((c) => c.type === "text");
				reply({ error: text ? text.text : "request failed" });
				return;
			}
			reply({ response: result.structuredContent });
		} catch (error) {
			reply({ error: "request failed" });
		}
	}

	expandEl.addEventListener("click", () => {
		const fullscreen = !document.body.classList.contains("fullscreen");
		request("ui/request-display-mode", { mode: fullscreen ? "fullscreen" : "inline" })
			.then((result) => {
				const mode = result && result.mode;
				document.body.classList.toggle("fullscreen", mode === "fullscreen");
				expandEl.textContent = mode === "fullscreen" ? "Collapse" : "Expand";
				reportSize();
			})
			.catch(() => {});
	});

	window.addEventListener("message", (event) => {
		// Requests from the sandboxed ThoughtSpot page.
		if (pageFrame && event.source === pageFrame.contentWindow) {
			const msg = event.data;
			if (msg && msg.__tsProxy === 1 && msg.kind === "request") {
				relayPageRequest(event.source, msg);
			}
			return;
		}

		if (event.source !== parent) return;
		const msg = event.data;
		if (!msg || msg.jsonrpc !== "2.0") return;

		if (msg.id !== undefined && !msg.method) {
			const entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			if (msg.error) entry.reject(msg.error);
			else entry.resolve(msg.result);
			return;
		}

		switch (msg.method) {
			case "ui/notifications/tool-result": {
				const params = msg.params || {};
				const target = params.structuredContent;
				if (params.isError || !target || !target.path) {
					const text = (params.content || []).find((c) => c.type === "text");
					showStatus(text ? text.text : "ThoughtSpot could not be opened.", true);
				} else {
					load(target.path);
				}
				break;
			}
			case "ping":
			case "ui/resource-teardown":
				if (msg.id !== undefined) send({ id: msg.id, result: {} });
				break;
			default:
				if (msg.id !== undefined) {
					send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
				}
		}
	});

	request("ui/initialize", {
		appInfo: { name: "ThoughtSpotApp", version: "1.0.0" },
		appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
		protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}",
	})
		.then(() => {
			notify("ui/notifications/initialized", {});
			reportSize();
		})
		.catch(() => showStatus("Could not connect to the host.", true));
})();
</script>
</body>
</html>
`;

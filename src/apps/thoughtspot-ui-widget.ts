// MCP Apps widget that renders the full ThoughtSpot UI inline.
//
// The server fetches the cluster's index.html, injects a proxy script at the top
// of <head>, and the widget loads the result through an <iframe srcdoc>. A srcdoc
// frame has no src URL, so the host's frameDomains restriction doesn't apply; the
// frame inherits the widget's origin and CSP instead. The proxy routes the app's
// same-origin API calls (fetch, XHR, <img>) to the cluster with the user's bearer
// token, since ThoughtSpot cookies aren't available in the host's sandbox.
//
// Pages that open their own nested iframes still won't load.
//
// SECURITY: the user's access token is embedded in the page HTML and lives in
// the browser for as long as the widget is open. It reaches the widget only
// through the app-only get_thoughtspot_page tool, so the model never sees it in
// hosts that honour tool visibility.

export const THOUGHTSPOT_UI_WIDGET_URI = "ui://thoughtspot/app.html";

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
 * everything the ThoughtSpot UI loads: assets from the CDNs and API calls to the
 * cluster (rewritten there by the proxy).
 */
export function thoughtspotUiCsp(instanceUrl: string) {
	const cluster = new URL(instanceUrl).origin;
	return {
		connectDomains: [cluster, ...THOUGHTSPOT_ASSET_ORIGINS],
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

// Serialize a value into an inline <script> safely: JSON-encode it, then escape
// "<" so a value can't close the script element.
function scriptLiteral(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function proxyScript(apiHost: string, authToken: string, route: string) {
	return `<script>
// Route all same-origin API calls to the remote ThoughtSpot host and
// attach the auth token. This replaces the local reverse proxy.
(function () {
	// Capture this script element so it can be removed from the DOM
	// once it has run, keeping the token only in this closure.
	var selfScript = document.currentScript;

	var API_HOST = ${scriptLiteral(apiHost)};
	var AUTH_TOKEN = ${scriptLiteral(authToken)};
	// In an <iframe srcdoc> the origin is inherited from the widget, or "null"
	// when the frame is opaque. new URL(x, "null") throws, so fall back to a
	// placeholder base that only relative URLs resolve against.
	var localOrigin =
		window.location.origin && window.location.origin !== "null"
			? window.location.origin
			: "https://srcdoc.invalid";

	// Open the requested page. about:srcdoc has no hash of its own.
	try {
		if (!window.location.hash) {
			history.replaceState(null, "", ${scriptLiteral(route)});
		}
	} catch (e) {
		try { window.location.hash = ${scriptLiteral(route)}; } catch (e2) {}
	}

	// Prevent the service worker from intercepting requests and
	// bypassing our fetch/XHR patches.
	try { localStorage.setItem('sw-disabled', 'true'); } catch (e) {}

	// A srcdoc document reports origin "null" but resolves relative URLs against
	// its parent's base URL, so app code that builds absolute URLs from
	// document.baseURI targets the parent's origin. Treat that origin as local too.
	var baseOrigin = null;
	try { baseOrigin = new URL(document.baseURI).origin; } catch (e) {}
	if (baseOrigin === 'null') baseOrigin = null;

	function shouldRewrite(url) {
		if (!url) return false;
		try {
			var origin = new URL(url, localOrigin).origin;
			return origin === localOrigin || (baseOrigin !== null && origin === baseOrigin);
		} catch (e) {
			return false;
		}
	}

	function rewrite(url) {
		var u = new URL(url, localOrigin);
		return API_HOST + u.pathname + u.search + u.hash;
	}

	// Strip custom x-* request headers to avoid CORS preflight failures.
	function stripXHeaders(headers) {
		var toDelete = [];
		headers.forEach(function (value, key) {
			if (key.toLowerCase().indexOf('x-') === 0) {
				toDelete.push(key);
			}
		});
		toDelete.forEach(function (key) {
			headers.delete(key);
		});
	}

	// Track which XHR instances are being redirected without exposing a
	// public property that other scripts could read or tamper with.
	var redirectedXhr = new WeakMap();

	// --- Patch fetch ---
	var origFetch = window.fetch;
	if (origFetch) {
		window.fetch = function (input, init) {
			try {
				// Strings, URL objects and Request objects all name a URL.
				var isUrlLike = typeof input === 'string' || input instanceof URL;
				var url = isUrlLike ? String(input) : (input && input.url);
				if (shouldRewrite(url)) {
					var newUrl = rewrite(url);
					if (isUrlLike) {
						init = init || {};
						var headers = new Headers(init.headers || {});
						stripXHeaders(headers);
						headers.set('Authorization', 'Bearer ' + AUTH_TOKEN);
						init.headers = headers;
						init.credentials = 'include';
						return origFetch(newUrl, init);
					}
					var req = new Request(newUrl, input);
					stripXHeaders(req.headers);
					req.headers.set('Authorization', 'Bearer ' + AUTH_TOKEN);
					return origFetch(req, init);
				}
			} catch (e) {
				console.error('[api-redirect] fetch patch error', e);
			}
			return origFetch(input, init);
		};
	}

	// --- Patch XMLHttpRequest ---
	var XHR = XMLHttpRequest;
	var xhrProto = XHR.prototype;
	var origOpen = xhrProto.open;
	var origSend = xhrProto.send;
	var origSetHeader = xhrProto.setRequestHeader;

	xhrProto.open = function (method, url) {
		try {
			if (shouldRewrite(url)) {
				redirectedXhr.set(this, true);
				url = rewrite(url);
			}
		} catch (e) {}
		return origOpen.apply(this, [method, url].concat([].slice.call(arguments, 2)));
	};

	xhrProto.setRequestHeader = function (name, value) {
		// Drop custom x-* headers on rewritten requests to avoid CORS preflight failures.
		if (redirectedXhr.get(this) && name && name.toLowerCase().indexOf('x-') === 0) {
			return;
		}
		return origSetHeader.apply(this, arguments);
	};

	xhrProto.send = function (body) {
		if (redirectedXhr.get(this)) {
			try { this.withCredentials = true; } catch (e) {}
			try { origSetHeader.call(this, 'Authorization', 'Bearer ' + AUTH_TOKEN); } catch (e) {}
		}
		return origSend.apply(this, arguments);
	};

	// --- Rewrite relative <img> sources to the remote host ---
	// The browser loads img src directly (not via fetch/XHR), so we
	// rewrite same-origin image URLs to point at the remote host.
	function rewriteImg(img) {
		var src = img.getAttribute('src');
		if (src && shouldRewrite(src)) {
			img.setAttribute('src', rewrite(src));
		}
		var srcset = img.getAttribute('srcset');
		if (srcset) {
			var updated = srcset.split(',').map(function (part) {
				var seg = part.trim().split(/\\s+/);
				if (seg[0] && shouldRewrite(seg[0])) {
					seg[0] = rewrite(seg[0]);
				}
				return seg.join(' ');
			}).join(', ');
			if (updated !== srcset) {
				img.setAttribute('srcset', updated);
			}
		}
	}

	// <img>.src = "/x" starts the request immediately, before the observer
	// below sees the attribute, so rewrite at the property setter too.
	try {
		var srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
		if (srcDesc && srcDesc.set) {
			Object.defineProperty(HTMLImageElement.prototype, 'src', {
				configurable: true,
				enumerable: srcDesc.enumerable,
				get: srcDesc.get,
				set: function (value) {
					var v = value != null && shouldRewrite(String(value)) ? rewrite(String(value)) : value;
					srcDesc.set.call(this, v);
				},
			});
		}
	} catch (e) {}

	function scanForImages(root) {
		if (root.tagName === 'IMG') rewriteImg(root);
		if (root.querySelectorAll) {
			root.querySelectorAll('img').forEach(rewriteImg);
		}
	}

	var imgObserver = new MutationObserver(function (mutations) {
		mutations.forEach(function (m) {
			if (m.type === 'attributes' && m.target.tagName === 'IMG') {
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
			attributeFilter: ['src', 'srcset'],
		});
	}
	document.addEventListener('DOMContentLoaded', function () {
		scanForImages(document);
	});

	console.log('[api-redirect] Routing same-origin API calls to ' + API_HOST);

	// Remove this script from the DOM so the injected token is no
	// longer readable by other scripts. The patched fetch/XHR keep
	// working because the token is retained in this closure.
	if (selfScript && selfScript.parentNode) {
		selfScript.parentNode.removeChild(selfScript);
	}
})();
</script>`;
}

/**
 * The cluster's index.html with the proxy script injected as the first element
 * of <head>, so it patches fetch/XHR before any ThoughtSpot script runs.
 */
export function injectProxyScript(
	indexHtml: string,
	{
		apiHost,
		authToken,
		route,
	}: { apiHost: string; authToken: string; route: string },
): string {
	const script = proxyScript(new URL(apiHost).origin, authToken, route);
	const head = /<head(\s[^>]*)?>/i.exec(indexHtml);
	if (!head) {
		return script + indexHtml;
	}
	const at = head.index + head[0].length;
	return `${indexHtml.slice(0, at)}\n${script}${indexHtml.slice(at)}`;
}

// Protocol version the widget announces in ui/initialize (LATEST_PROTOCOL_VERSION in ext-apps).
const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

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
			iframe.srcdoc = page.html;
			frameEl.replaceChildren(iframe);
			reportSize();
		} catch (error) {
			if (currentPath !== path) return;
			showStatus("Could not load ThoughtSpot.", true);
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

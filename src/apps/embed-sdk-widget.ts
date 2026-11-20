// Approach B prototype: MCP Apps widget that renders ThoughtSpot with the Visual
// Embed SDK, framing the customer's cluster directly.
//
// The widget loads the SDK from a pinned CDN build and calls init() with
// AuthType.TrustedAuthTokenCookieless. The SDK's getAuthToken callback calls the
// app-only get_embed_token tool, which mints a short-lived token for the user on
// the server and returns it. The SDK then frames the cluster (AppEmbed) and passes
// the token to it as a bearer token.
//
// Unlike approach A (show_answer), the token reaches page JavaScript, and the
// cluster must allow the host's sandbox origin:
//   - in its CSP "Visual Embed hosts" (frame-ancestors), so the frame loads;
//   - in its CORS allowlist, because init() calls /callosum/v1/session/info and
//     friends from the widget origin with the bearer token.
// Neither can be set from here: a cluster admin has to add them.
//
// Off by default; the undocumented `embed-sdk=true` URL flag turns it on.

export const EMBED_SDK_WIDGET_URI = "ui://thoughtspot/embed-sdk.html";

// Pinned Visual Embed SDK build (UMD bundle, exposes window.tsembed). Pinned so a
// new SDK release can't change what runs in the host without a code change.
export const EMBED_SDK_VERSION = "1.54.0";
export const EMBED_SDK_CDN_ORIGIN = "https://cdn.jsdelivr.net";
export const EMBED_SDK_SCRIPT_URL = `${EMBED_SDK_CDN_ORIGIN}/npm/@thoughtspot/visual-embed-sdk@${EMBED_SDK_VERSION}/dist/tsembed.js`;

// Lifetime of the token handed to the widget. Short, because the token is a full
// user token (the mint endpoint takes a validity and org, not a scope) and any
// script in the widget can read it. The SDK calls getAuthToken again when the
// frame asks for a fresh one.
export const EMBED_TOKEN_VALIDITY_SEC = 5 * 60;

/**
 * CSP for the widget resource. The SDK script comes from the CDN, init() calls
 * the cluster from the widget (connect-src), and AppEmbed frames the cluster
 * (frame-src). The frame domain is the connected cluster's own origin, so custom
 * domains work without a shared wildcard.
 */
export function embedSdkCsp(instanceUrl: string) {
	const cluster = new URL(instanceUrl).origin;
	return {
		resourceDomains: [EMBED_SDK_CDN_ORIGIN],
		connectDomains: [cluster],
		frameDomains: [cluster],
	};
}

/**
 * The AppEmbed `path` for a ThoughtSpot hash route: AppEmbed builds
 * `<host>/?<params>#/<path>`, so "#/embed/conv-assist-answer?..." becomes
 * "embed/conv-assist-answer?...".
 */
export function embedPathForRoute(route: string): string {
	return route.replace(/^#\//, "");
}

export function embedSdkToolMeta() {
	return {
		ui: { resourceUri: EMBED_SDK_WIDGET_URI },
		"ui/resourceUri": EMBED_SDK_WIDGET_URI,
	};
}

// Protocol version the widget announces in ui/initialize (LATEST_PROTOCOL_VERSION in ext-apps).
const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

export const EMBED_SDK_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
	* { box-sizing: border-box; }
	html, body { margin: 0; background: transparent; color: #6b7280;
		font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
	#embed { width: 100%; height: 640px; border: 1px solid #e5e7eb;
		border-radius: 8px; overflow: hidden; background: #fff; }
	#embed iframe { width: 100%; height: 100%; border: 0; }
	.status { padding: 24px; text-align: center; }
	.status.error { color: #b42318; white-space: pre-wrap; }
</style>
<script src="${EMBED_SDK_SCRIPT_URL}"></script>
</head>
<body>
<div id="embed"><div class="status">Loading ThoughtSpot…</div></div>
<script>
(() => {
	const parent = window.parent;
	const pending = new Map();
	let nextId = 1;
	let embed;
	let initialized = false;
	const embedEl = document.getElementById("embed");

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
		embedEl.replaceChildren(el);
		reportSize();
	}
	function textOf(result) {
		const text = ((result && result.content) || []).find((c) => c.type === "text");
		return text ? text.text : undefined;
	}

	// getAuthToken for the SDK: a fresh short-lived token from the server.
	async function getAuthToken() {
		const result = await request("tools/call", {
			name: "get_embed_token",
			arguments: {},
		});
		const token = result && result.structuredContent && result.structuredContent.token;
		if (result.isError || !token) {
			throw new Error(textOf(result) || "Could not get a ThoughtSpot token.");
		}
		return token;
	}

	function render(payload) {
		const sdk = window.tsembed;
		if (!sdk) {
			showStatus("Could not load the ThoughtSpot Visual Embed SDK.", true);
			return;
		}
		if (!payload || !payload.thoughtspot_host || typeof payload.path !== "string") {
			showStatus("Nothing to show.", true);
			return;
		}
		if (!initialized) {
			const authEvent = sdk.init({
				thoughtSpotHost: payload.thoughtspot_host,
				authType: sdk.AuthType.TrustedAuthTokenCookieless,
				getAuthToken,
				autoLogin: true,
			});
			if (authEvent && authEvent.on) {
				authEvent.on(sdk.AuthStatus.FAILURE, (reason) => {
					showStatus(
						"ThoughtSpot sign-in failed (" + String(reason) + ").\\n" +
						"The cluster must list this host's sandbox origin in its CSP " +
						"Visual Embed hosts and CORS allowlist.",
						true,
					);
				});
			}
			initialized = true;
		}
		embedEl.replaceChildren();
		embed = new sdk.AppEmbed(embedEl, {
			path: payload.path,
			showPrimaryNavbar: false,
			frameParams: { width: "100%", height: "100%" },
		});
		embed.on(sdk.EmbedEvent.Load, reportSize);
		embed.on(sdk.EmbedEvent.Error, (error) => {
			showStatus("ThoughtSpot reported an error: " + JSON.stringify(error), true);
		});
		embed.render();
		reportSize();
	}

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
			case "ui/notifications/tool-result":
				if (msg.params && msg.params.isError) {
					showStatus(textOf(msg.params) || "Could not open ThoughtSpot.", true);
				} else {
					render(msg.params && msg.params.structuredContent);
				}
				break;
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
		appInfo: { name: "ThoughtSpotEmbedSdk", version: "0.1.0" },
		appCapabilities: {},
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

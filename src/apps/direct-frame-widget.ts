// Approach C2 prototype: frame a page served by the customer's cluster directly,
// declared in the widget CSP's frameDomains.
//
// In the real C2, ThoughtSpot ships a small MCP view page at a stable URL and the
// widget passes it a short-lived, view-scoped token. Neither exists yet, so this
// stand-in frames the nearest existing thing: the answer's `iframe_url`
// (`/?tsmcp=true#/embed/conv-assist-answer?...`), a full-app embed route, with no
// token at all. It answers the open questions C2 depends on:
//   - does the host load a cross-origin frame to the cluster when frameDomains
//     declares it (Claude; ChatGPT blocks nested frames unless approved)?
//   - does the cluster let the host's sandbox origin frame it (its CSP Visual
//     Embed hosts / frame-ancestors)?
//   - does the route authenticate inside a host frame? It relies on a session
//     cookie, which third-party cookie blocking (Safari, Chrome Incognito) drops,
//     so a signed-out frame is an expected and valid result.
//
// Off by default; the undocumented `direct-frame=true` URL flag turns it on.

export const DIRECT_FRAME_WIDGET_URI = "ui://thoughtspot/direct-frame.html";

/** CSP for the widget: it frames the connected cluster and loads nothing else. */
export function directFrameCsp(instanceUrl: string) {
	return { frameDomains: [new URL(instanceUrl).origin] };
}

/**
 * The URL to frame for a target: an `iframe_url` on the connected instance is
 * framed as is (it carries the embed route and its query); a hash route becomes
 * `<instance>/#/...`. Anything else is undefined.
 */
export function directFrameUrl(
	instanceUrl: string,
	target: string,
): string | undefined {
	const origin = new URL(instanceUrl).origin;
	if (target.startsWith("#/")) {
		return `${origin}/${target}`;
	}
	try {
		const url = new URL(target);
		if (url.origin === origin && url.hash.startsWith("#/")) {
			return url.toString();
		}
	} catch {
		// Not a URL.
	}
	return undefined;
}

export function directFrameToolMeta() {
	return {
		ui: { resourceUri: DIRECT_FRAME_WIDGET_URI },
		"ui/resourceUri": DIRECT_FRAME_WIDGET_URI,
	};
}

// Protocol version the widget announces in ui/initialize (LATEST_PROTOCOL_VERSION in ext-apps).
const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

export const DIRECT_FRAME_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
	* { box-sizing: border-box; }
	html, body { margin: 0; background: transparent; color: #6b7280;
		font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
	iframe { display: block; width: 100%; height: 640px; border: 1px solid #e5e7eb;
		border-radius: 8px; background: #fff; }
	.note { padding: 6px 2px; }
	.status { padding: 24px; text-align: center; font-size: 14px; }
	.status.error { color: #b42318; }
</style>
</head>
<body>
<div id="frame"><div class="status">Waiting for a page…</div></div>
<div class="note" id="note" hidden>Prototype (C2 stand-in): the cluster is framed directly with no token. A login page or a blank frame means the cluster refused this host's origin or no session cookie reached it.</div>
<script>
(() => {
	const parent = window.parent;
	const pending = new Map();
	let nextId = 1;
	const frameEl = document.getElementById("frame");
	const noteEl = document.getElementById("note");

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
	function textOf(result) {
		const text = ((result && result.content) || []).find((c) => c.type === "text");
		return text ? text.text : undefined;
	}
	function showStatus(text, isError) {
		const el = document.createElement("div");
		el.className = isError ? "status error" : "status";
		el.textContent = text;
		frameEl.replaceChildren(el);
		reportSize();
	}
	function show(payload) {
		if (!payload || typeof payload.frame_url !== "string") {
			showStatus("Nothing to show.", true);
			return;
		}
		const frame = document.createElement("iframe");
		frame.src = payload.frame_url;
		frame.title = "ThoughtSpot";
		frame.referrerPolicy = "origin";
		frameEl.replaceChildren(frame);
		noteEl.hidden = false;
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
					show(msg.params && msg.params.structuredContent);
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
		appInfo: { name: "ThoughtSpotDirectFrame", version: "0.1.0" },
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

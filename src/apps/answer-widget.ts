// MCP Apps (io.modelcontextprotocol/ui) widget that shows an Analytics Agent answer
// inline in hosts that render MCP App UI resources (Claude, ChatGPT, ...).
//
// Hosts can't frame the answer's `iframe_url` directly: nested frames to the
// ThoughtSpot instance need host CSP `frameDomains` (restricted in Claude) and
// third-party cookies for auth. Instead the widget asks the server for a PNG
// export of the answer (fetched with the user's token, server side) and shows it
// as a data: URL, plus a button that opens the answer in ThoughtSpot.
//
// The widget speaks the MCP Apps postMessage JSON-RPC protocol by hand rather
// than inlining the ~540KB @modelcontextprotocol/ext-apps browser bundle.

export const ANSWER_WIDGET_URI = "ui://thoughtspot/answer.html";

// MIME type hosts use to recognise an MCP App resource (RESOURCE_MIME_TYPE in ext-apps).
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

// Protocol version the widget announces in ui/initialize (LATEST_PROTOCOL_VERSION in ext-apps).
const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/**
 * `_meta` for a tool whose results render in the answer widget. Sets both the
 * current nested key and the legacy flat key, as ext-apps' registerAppTool does.
 */
export function answerWidgetToolMeta() {
	return {
		ui: { resourceUri: ANSWER_WIDGET_URI },
		"ui/resourceUri": ANSWER_WIDGET_URI,
	};
}

/**
 * Link that opens the answer in ThoughtSpot, from the `iframe_url` returned by
 * get_session_updates. Only URLs on the connected instance are accepted, so a
 * model-supplied value can't point the button elsewhere. `tsmcp=true` marks the
 * embed for MCP clients and is dropped for a browser tab.
 */
export function buildAnswerOpenUrl(
	instanceUrl: string,
	iframeUrl: string | undefined,
): string | undefined {
	if (!iframeUrl) {
		return undefined;
	}
	try {
		const url = new URL(iframeUrl);
		if (url.origin !== new URL(instanceUrl).origin) {
			return undefined;
		}
		url.searchParams.delete("tsmcp");
		return url.toString();
	} catch {
		return undefined;
	}
}

export const ANSWER_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<style>
	:root {
		--fg: #1d232f;
		--muted: #6b7280;
		--border: #e5e7eb;
		--accent: #2770ef;
		--accent-fg: #ffffff;
		--error: #b42318;
		color-scheme: light;
	}
	:root.dark {
		--fg: #e5e7eb;
		--muted: #9ca3af;
		--border: #374151;
		--accent: #5b93f5;
		--error: #f97066;
		color-scheme: dark;
	}
	* { box-sizing: border-box; }
	html, body { margin: 0; background: transparent; color: var(--fg);
		font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
	.card { padding: 12px; }
	header { display: flex; align-items: center; justify-content: space-between;
		gap: 12px; margin-bottom: 10px; }
	h1 { font-size: 15px; font-weight: 600; margin: 0; overflow: hidden;
		text-overflow: ellipsis; white-space: nowrap; }
	button { font: inherit; border: 0; border-radius: 6px; padding: 6px 12px;
		background: var(--accent); color: var(--accent-fg); cursor: pointer; flex: none; }
	button[hidden] { display: none; }
	.frame { border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
		min-height: 120px; display: flex; align-items: center; justify-content: center; }
	img { display: block; width: 100%; height: auto; background: #fff; }
	.status { color: var(--muted); padding: 24px; text-align: center; }
	.status.error { color: var(--error); }
</style>
</head>
<body>
<div class="card">
	<header>
		<h1 id="title">ThoughtSpot answer</h1>
		<button id="open" type="button" hidden>Open in ThoughtSpot</button>
	</header>
	<div class="frame" id="frame"><div class="status">Waiting for answer…</div></div>
</div>
<script>
(() => {
	const parent = window.parent;
	const pending = new Map();
	let nextId = 1;
	let currentAnswerId;
	let openUrl;

	const titleEl = document.getElementById("title");
	const frameEl = document.getElementById("frame");
	const openEl = document.getElementById("open");

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

	function applyTheme(context) {
		if (context && context.theme) {
			document.documentElement.classList.toggle("dark", context.theme === "dark");
		}
	}

	function showStatus(text, isError) {
		const el = document.createElement("div");
		el.className = isError ? "status error" : "status";
		el.textContent = text;
		frameEl.replaceChildren(el);
		reportSize();
	}

	async function getAnswerImage(answer) {
		if (!answer || !answer.answer_id) {
			showStatus("No answer to show.", true);
			return;
		}
		currentAnswerId = answer.answer_id;
		titleEl.textContent = answer.title || "ThoughtSpot answer";
		openUrl = answer.open_url;
		openEl.hidden = !openUrl;
		showStatus("Loading visualization…");

		try {
			const result = await request("tools/call", {
				name: "fetch_answer_image",
				arguments: { answer_id: answer.answer_id },
			});
			// A newer tool result replaced this answer while the export ran.
			if (currentAnswerId !== answer.answer_id) return;
			const image = (result.content || []).find((c) => c.type === "image");
			if (result.isError || !image) {
				const text = (result.content || []).find((c) => c.type === "text");
				showStatus(text ? text.text : "Could not load the visualization.", true);
				return;
			}
			const img = document.createElement("img");
			img.alt = titleEl.textContent;
			img.onload = reportSize;
			img.src = "data:" + image.mimeType + ";base64," + image.data;
			frameEl.replaceChildren(img);
		} catch (error) {
			if (currentAnswerId !== answer.answer_id) return;
			showStatus("Could not load the visualization.", true);
		}
	}

	function answerFromToolResult(params) {
		if (!params) return undefined;
		if (params.structuredContent) return params.structuredContent;
		const text = (params.content || []).find((c) => c.type === "text");
		try {
			return text ? JSON.parse(text.text) : undefined;
		} catch {
			return undefined;
		}
	}

	openEl.addEventListener("click", () => {
		if (openUrl) request("ui/open-link", { url: openUrl }).catch(() => {});
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
			case "ui/notifications/tool-result":
				if (msg.params && msg.params.isError) {
					const text = (msg.params.content || []).find((c) => c.type === "text");
					showStatus(text ? text.text : "The answer could not be shown.", true);
				} else {
					getAnswerImage(answerFromToolResult(msg.params));
				}
				break;
			case "ui/notifications/host-context-changed":
				applyTheme(msg.params);
				break;
			case "ping":
			case "ui/resource-teardown":
				if (msg.id !== undefined) send({ id: msg.id, result: {} });
				break;
			default:
				// Answer unknown requests so the host doesn't wait on them.
				if (msg.id !== undefined) {
					send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
				}
		}
	});

	request("ui/initialize", {
		appInfo: { name: "ThoughtSpotAnswer", version: "1.0.0" },
		appCapabilities: {},
		protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}",
	})
		.then((result) => {
			applyTheme(result && result.hostContext);
			notify("ui/notifications/initialized", {});
			reportSize();
		})
		.catch(() => showStatus("Could not connect to the host.", true));
})();
</script>
</body>
</html>
`;

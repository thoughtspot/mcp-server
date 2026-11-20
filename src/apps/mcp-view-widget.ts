// Approach C1 prototype: a small, purpose-built "MCP view" page loaded like
// approach A (HTML into an <iframe srcdoc>, API calls relayed through the MCP
// server), but talking to a fixed, documented set of read endpoints instead of
// the whole ThoughtSpot app.
//
// In the real C1, ThoughtSpot ships the page and the cluster serves it. That page
// does not exist yet, so MCP_VIEW_PAGE_HTML below stands in for it. It is a thin
// renderer (a table plus a simple bar chart), not ThoughtSpot's chart library, so
// it says nothing about fidelity. What it does test:
//   - the delivery model with no allow-same-origin: the page runs with an opaque
//     origin and can only postMessage the widget;
//   - least privilege: thoughtspot_view_request relays only the requests in
//     VIEW_RELAY_ALLOWLIST (exact method, path and body keys), with its own nonce,
//     separate from A's broad thoughtspot_api_request relay;
//   - how many relay calls an answer or Liveboard needs (latency).
//
// Off by default; the undocumented `mcp-view=true` URL flag turns it on.

import { ApiRelayRejectedError } from "./thoughtspot-ui-widget";

export const MCP_VIEW_WIDGET_URI = "ui://thoughtspot/mcp-view.html";

// ── Read-only relay allowlist (the C1 API contract) ─────────────────────────

type AllowedViewRequest = {
	method: "POST";
	path: string;
	// Top-level JSON body keys the page may send. Anything else is rejected.
	bodyKeys: readonly string[];
	// Extra checks on the parsed body.
	checkBody?: (body: Record<string, unknown>) => string | undefined;
};

/**
 * Every request the MCP view page may make. These are all reads, but two are
 * POSTs (REST v2 takes the query in the body), so the allowlist is by exact
 * method, path and body keys rather than "GET only".
 */
export const VIEW_RELAY_ALLOWLIST: readonly AllowedViewRequest[] = [
	{
		// Rows of an unsaved Analytics Agent answer, as CSV (as get_data does).
		method: "POST",
		path: "/api/rest/2.0/report/answer",
		bodyKeys: ["session_identifier", "generation_number", "file_format"],
		checkBody: (body) =>
			body.file_format === "CSV" ? undefined : "file_format must be CSV",
	},
	{
		// Rows of a saved Answer.
		method: "POST",
		path: "/api/rest/2.0/metadata/answer/data",
		bodyKeys: [
			"metadata_identifier",
			"data_format",
			"record_offset",
			"record_size",
		],
	},
	{
		// Rows of a Liveboard's visualizations.
		method: "POST",
		path: "/api/rest/2.0/metadata/liveboard/data",
		bodyKeys: [
			"metadata_identifier",
			"visualization_identifiers",
			"data_format",
			"record_offset",
			"record_size",
		],
	},
];

export type ViewRelayRequest = {
	method: string;
	path: string;
	body?: string;
};

/**
 * Check a page request against VIEW_RELAY_ALLOWLIST. The path must match exactly
 * (no query, no encoding tricks) and the body must be a JSON object with only the
 * allowed keys. Throws ApiRelayRejectedError otherwise.
 */
export function checkViewRelayRequest(request: ViewRelayRequest): void {
	const method = request.method.toUpperCase();
	const entry = VIEW_RELAY_ALLOWLIST.find(
		(allowed) => allowed.method === method && allowed.path === request.path,
	);
	if (!entry) {
		throw new ApiRelayRejectedError(
			`${method} ${request.path.slice(0, 100)} is not a view endpoint`,
		);
	}
	let body: unknown;
	try {
		body = JSON.parse(request.body ?? "");
	} catch {
		throw new ApiRelayRejectedError("body must be JSON");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ApiRelayRejectedError("body must be a JSON object");
	}
	const extra = Object.keys(body).filter(
		(key) => !entry.bodyKeys.includes(key),
	);
	if (extra.length) {
		throw new ApiRelayRejectedError(
			`body has keys not allowed for this endpoint: ${extra.join(", ")}`,
		);
	}
	const problem = entry.checkBody?.(body as Record<string, unknown>);
	if (problem) {
		throw new ApiRelayRejectedError(problem);
	}
}

// ── Stand-in MCP view page ──────────────────────────────────────────────────

// Message tag for page <-> widget postMessage traffic.
const VIEW_MESSAGE_SOURCE = "thoughtspot-mcp-view";

/**
 * The stand-in for ThoughtSpot's MCP view page. Self-contained (no external
 * scripts, styles or fonts), so the widget CSP needs no domains. It never sees a
 * token or a nonce: it asks the widget for each request by postMessage.
 */
export const MCP_VIEW_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
	* { box-sizing: border-box; }
	html, body { margin: 0; background: #fff; color: #1d232f;
		font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
	main { padding: 12px; }
	h2 { font-size: 14px; margin: 16px 0 8px; }
	h2:first-child { margin-top: 0; }
	.status { color: #6b7280; padding: 16px; text-align: center; }
	.status.error { color: #b42318; }
	table { border-collapse: collapse; width: 100%; }
	th, td { border-bottom: 1px solid #e5e7eb; padding: 4px 8px; text-align: left; }
	th { background: #f9fafb; font-weight: 600; }
	td.num { text-align: right; font-variant-numeric: tabular-nums; }
	.scroll { max-height: 320px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 6px; }
	svg { display: block; margin-bottom: 8px; }
	.meta { color: #6b7280; font-size: 12px; margin-top: 6px; }
</style>
</head>
<body>
<main id="root"><div class="status">Loading…</div></main>
<script>
(() => {
	const SOURCE = "${VIEW_MESSAGE_SOURCE}";
	const root = document.getElementById("root");
	const pending = new Map();
	let nextId = 1;
	let relayCalls = 0;
	const started = Date.now();

	function post(message) {
		// The widget is the only thing that can hear us; our origin is opaque.
		window.parent.postMessage({ source: SOURCE, ...message }, "*");
	}
	function reportSize() {
		post({ type: "size", height: Math.ceil(document.documentElement.scrollHeight) });
	}
	function relay(path, body) {
		const id = nextId++;
		relayCalls++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			post({ type: "relay", id, method: "POST", path, body: JSON.stringify(body) });
		});
	}
	function status(text, isError) {
		const el = document.createElement("div");
		el.className = isError ? "status error" : "status";
		el.textContent = text;
		root.replaceChildren(el);
		reportSize();
	}

	function parseCsv(text) {
		const rows = [];
		let row = [], field = "", quoted = false;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (quoted) {
				if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
				else if (c === '"') quoted = false;
				else field += c;
			} else if (c === '"') quoted = true;
			else if (c === ",") { row.push(field); field = ""; }
			else if (c === "\\n" || c === "\\r") {
				if (c === "\\r" && text[i + 1] === "\\n") i++;
				row.push(field); rows.push(row); row = []; field = "";
			} else field += c;
		}
		if (field !== "" || row.length) { row.push(field); rows.push(row); }
		return rows.filter((r) => r.length > 1 || r[0] !== "");
	}

	const isNum = (v) => v !== "" && v !== null && v !== undefined && !isNaN(Number(v));

	function barChart(columns, rows) {
		// One label column and one numeric column: draw bars for the first 20 rows.
		const numIdx = columns.findIndex((_, i) => rows.length && rows.every((r) => isNum(r[i])));
		const labelIdx = columns.findIndex((_, i) => i !== numIdx);
		if (numIdx < 0 || labelIdx < 0 || rows.length < 2) return null;
		const data = rows.slice(0, 20).map((r) => ({ label: String(r[labelIdx]), value: Number(r[numIdx]) }));
		const max = Math.max(...data.map((d) => Math.abs(d.value))) || 1;
		const ns = "http://www.w3.org/2000/svg";
		const rowH = 18, labelW = 140, width = 520;
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("width", "100%");
		svg.setAttribute("viewBox", "0 0 " + width + " " + data.length * rowH);
		data.forEach((d, i) => {
			const label = document.createElementNS(ns, "text");
			label.setAttribute("x", labelW - 6);
			label.setAttribute("y", i * rowH + 13);
			label.setAttribute("text-anchor", "end");
			label.setAttribute("font-size", "11");
			label.textContent = d.label.length > 22 ? d.label.slice(0, 21) + "…" : d.label;
			const bar = document.createElementNS(ns, "rect");
			bar.setAttribute("x", labelW);
			bar.setAttribute("y", i * rowH + 3);
			bar.setAttribute("height", rowH - 6);
			bar.setAttribute("width", Math.max(1, (Math.abs(d.value) / max) * (width - labelW - 8)));
			bar.setAttribute("fill", "#2770ef");
			svg.append(label, bar);
		});
		const caption = document.createElement("div");
		caption.className = "meta";
		caption.textContent = columns[numIdx] + " by " + columns[labelIdx];
		const wrap = document.createElement("div");
		wrap.append(svg, caption);
		return wrap;
	}

	function table(columns, rows) {
		const t = document.createElement("table");
		const head = t.createTHead().insertRow();
		columns.forEach((c) => {
			const th = document.createElement("th");
			th.textContent = c;
			head.append(th);
		});
		const body = t.createTBody();
		rows.slice(0, 500).forEach((r) => {
			const tr = body.insertRow();
			columns.forEach((_, i) => {
				const td = tr.insertCell();
				const v = r[i];
				td.textContent = v === null || v === undefined ? "" : String(v);
				if (isNum(v)) td.className = "num";
			});
		});
		const scroll = document.createElement("div");
		scroll.className = "scroll";
		scroll.append(t);
		return scroll;
	}

	function section(title, columns, rows) {
		const frag = document.createDocumentFragment();
		if (title) {
			const h = document.createElement("h2");
			h.textContent = title;
			frag.append(h);
		}
		const chart = barChart(columns, rows);
		if (chart) frag.append(chart);
		frag.append(table(columns, rows));
		return frag;
	}

	function footer() {
		const meta = document.createElement("div");
		meta.className = "meta";
		meta.textContent = relayCalls + " relay call(s), " + (Date.now() - started) + " ms";
		return meta;
	}

	async function check(response) {
		if (response.status < 200 || response.status >= 300) {
			throw new Error("ThoughtSpot returned " + response.status);
		}
		return response.body;
	}

	async function renderAnswer(view) {
		const csv = await check(await relay("/api/rest/2.0/report/answer", {
			session_identifier: view.session_identifier,
			generation_number: view.generation_number,
			file_format: "CSV",
		}));
		const [columns = [], ...rows] = parseCsv(csv);
		root.replaceChildren(section(view.title, columns, rows), footer());
	}

	function normalize(content) {
		const columns = content.column_names || [];
		const rows = (content.data_rows || []).map((r) =>
			Array.isArray(r) ? r : columns.map((c) => r[c]),
		);
		return { columns, rows };
	}

	async function renderLiveboard(view) {
		const body = {
			metadata_identifier: view.liveboard_id,
			data_format: "COMPACT",
			record_offset: 0,
			record_size: 500,
		};
		if (view.visualization_ids && view.visualization_ids.length) {
			body.visualization_identifiers = view.visualization_ids;
		}
		const text = await check(await relay("/api/rest/2.0/metadata/liveboard/data", body));
		const data = JSON.parse(text);
		const frag = document.createDocumentFragment();
		if (view.title) {
			const h = document.createElement("h2");
			h.textContent = view.title;
			frag.append(h);
		}
		(data.contents || []).forEach((content) => {
			const { columns, rows } = normalize(content);
			frag.append(section(content.visualization_name || "Visualization", columns, rows));
		});
		root.replaceChildren(frag, footer());
	}

	window.addEventListener("message", async (event) => {
		if (event.source !== window.parent) return;
		const msg = event.data;
		if (!msg || msg.source !== SOURCE) return;
		if (msg.type === "relay-result") {
			const entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			if (msg.error) entry.reject(new Error(msg.error));
			else entry.resolve(msg.response);
			return;
		}
		if (msg.type === "render") {
			status("Loading data…");
			try {
				if (msg.view.kind === "answer") await renderAnswer(msg.view);
				else if (msg.view.kind === "liveboard") await renderLiveboard(msg.view);
				else throw new Error("Unknown view");
			} catch (error) {
				status("Could not load the data: " + error.message, true);
			}
			reportSize();
		}
	});

	post({ type: "ready" });
})();
</script>
</body>
</html>
`;

// ── Widget ─────────────────────────────────────────────────────────────────

// Protocol version the widget announces in ui/initialize (LATEST_PROTOCOL_VERSION in ext-apps).
const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

// No allow-same-origin: the page gets an opaque origin, so it can't reach into
// the widget document or speak to the host as the widget.
export const MCP_VIEW_FRAME_SANDBOX = "allow-scripts";

export function mcpViewToolMeta() {
	return {
		ui: { resourceUri: MCP_VIEW_WIDGET_URI },
		"ui/resourceUri": MCP_VIEW_WIDGET_URI,
	};
}

export const MCP_VIEW_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
	* { box-sizing: border-box; }
	html, body { margin: 0; background: transparent; color: #6b7280;
		font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
	iframe { display: block; width: 100%; height: 200px; border: 1px solid #e5e7eb;
		border-radius: 8px; background: #fff; }
	.status { padding: 24px; text-align: center; }
	.status.error { color: #b42318; }
</style>
</head>
<body>
<div id="frame"><div class="status">Loading…</div></div>
<script>
(() => {
	const SOURCE = "${VIEW_MESSAGE_SOURCE}";
	const parent = window.parent;
	const pending = new Map();
	let nextId = 1;
	let frame;
	let relayNonce;
	let view;
	const frameEl = document.getElementById("frame");

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
		frame = undefined;
		reportSize();
	}
	function toBase64(text) {
		const bytes = new TextEncoder().encode(text);
		let binary = "";
		bytes.forEach((b) => { binary += String.fromCharCode(b); });
		return btoa(binary);
	}
	function fromBase64(data) {
		const binary = atob(data || "");
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	}
	function toPage(message) {
		// The page's origin is opaque, so "*" is the only target that reaches it;
		// we only ever post to our own frame's window.
		if (frame && frame.contentWindow) {
			frame.contentWindow.postMessage({ source: SOURCE, ...message }, "*");
		}
	}

	async function open(nextView) {
		view = nextView;
		showStatus("Loading…");
		const result = await request("tools/call", {
			name: "get_mcp_view_page",
			arguments: {},
		});
		const page = result && result.structuredContent;
		if (result.isError || !page || !page.html || !page.relay_nonce) {
			showStatus(textOf(result) || "Could not load the view.", true);
			return;
		}
		relayNonce = page.relay_nonce;
		frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "${MCP_VIEW_FRAME_SANDBOX}");
		frame.srcdoc = page.html;
		frameEl.replaceChildren(frame);
		reportSize();
	}

	async function relay(msg) {
		try {
			const result = await request("tools/call", {
				name: "thoughtspot_view_request",
				arguments: {
					method: msg.method,
					path: msg.path,
					body_base64: toBase64(msg.body || ""),
					relay_nonce: relayNonce,
				},
			});
			const response = result && result.structuredContent;
			if (result.isError || !response) {
				toPage({ type: "relay-result", id: msg.id, error: textOf(result) || "Request failed" });
				return;
			}
			toPage({
				type: "relay-result",
				id: msg.id,
				response: { status: response.status, body: fromBase64(response.body_base64) },
			});
		} catch (error) {
			toPage({ type: "relay-result", id: msg.id, error: "Request failed" });
		}
	}

	window.addEventListener("message", (event) => {
		// Messages from our page frame.
		if (frame && event.source === frame.contentWindow) {
			const msg = event.data;
			if (!msg || msg.source !== SOURCE) return;
			if (msg.type === "ready") toPage({ type: "render", view });
			else if (msg.type === "relay" && typeof msg.id === "number") relay(msg);
			else if (msg.type === "size" && typeof msg.height === "number") {
				frame.style.height = Math.min(Math.max(msg.height + 2, 120), 1600) + "px";
				reportSize();
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
			case "ui/notifications/tool-result":
				if (msg.params && msg.params.isError) {
					showStatus(textOf(msg.params) || "Could not show the view.", true);
				} else if (msg.params && msg.params.structuredContent) {
					open(msg.params.structuredContent).catch(() =>
						showStatus("Could not load the view.", true),
					);
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
		appInfo: { name: "ThoughtSpotMcpView", version: "0.1.0" },
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

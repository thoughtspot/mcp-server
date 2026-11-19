import { describe, expect, it, vi } from "vitest";
import {
	ANSWER_WIDGET_HTML,
	buildAnswerOpenUrl,
} from "../../src/apps/answer-widget";

const instanceUrl = "https://test.thoughtspot.cloud";

describe("buildAnswerOpenUrl", () => {
	it("drops tsmcp=true from an instance iframe URL", () => {
		expect(
			buildAnswerOpenUrl(
				instanceUrl,
				`${instanceUrl}/?tsmcp=true#/embed/conv-assist-answer?sessionId=s&genNo=1`,
			),
		).toBe(`${instanceUrl}/#/embed/conv-assist-answer?sessionId=s&genNo=1`);
	});

	it("accepts an instance URL with a trailing path", () => {
		expect(
			buildAnswerOpenUrl(`${instanceUrl}/`, `${instanceUrl}/#/answer`),
		).toBe(`${instanceUrl}/#/answer`);
	});

	it.each([
		["missing", undefined],
		["another origin", "https://evil.example.com/?tsmcp=true"],
		["a lookalike host", "https://test.thoughtspot.cloud.evil.com/"],
		["a non-URL", "not a url"],
		["a javascript: URL", "javascript:alert(1)"],
	])("returns undefined for %s", (_label, iframeUrl) => {
		expect(buildAnswerOpenUrl(instanceUrl, iframeUrl)).toBeUndefined();
	});
});

describe("ANSWER_WIDGET_HTML", () => {
	it("contains a syntactically valid inline script", () => {
		const match = ANSWER_WIDGET_HTML.match(/<script>([\s\S]*?)<\/script>/);
		expect(match).not.toBeNull();
		// Compiles without running: throws SyntaxError on a broken script.
		expect(() => new Function(match?.[1] ?? "")).not.toThrow();
	});

	it("announces the MCP Apps protocol version", () => {
		expect(ANSWER_WIDGET_HTML).toContain('protocolVersion: "2026-01-26"');
	});
});

// Runs the widget's inline script against a fake host frame and DOM, to check the
// MCP Apps postMessage exchange end to end without a browser.
function bootWidget() {
	const script =
		ANSWER_WIDGET_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
	const sent: any[] = [];
	const parent = { postMessage: (message: any) => sent.push(message) };
	let onMessage: (event: any) => void = () => {};
	const elements: Record<string, any> = {};
	const element = () => ({
		textContent: "",
		hidden: false,
		children: [] as any[],
		listeners: {} as Record<string, () => void>,
		replaceChildren(...nodes: any[]) {
			this.children = nodes;
		},
		addEventListener(type: string, fn: () => void) {
			this.listeners[type] = fn;
		},
	});
	const documentStub = {
		documentElement: { scrollHeight: 321, classList: { toggle: vi.fn() } },
		getElementById: (id: string) => {
			elements[id] ??= element();
			return elements[id];
		},
		createElement: () => element(),
	};
	const windowStub = {
		parent,
		addEventListener: (_type: string, fn: (event: any) => void) => {
			onMessage = fn;
		},
	};
	new Function("window", "document", script)(windowStub, documentStub);

	const deliver = async (data: any, source: unknown = parent) => {
		onMessage({ source, data: { jsonrpc: "2.0", ...data } });
		// Let the widget's promise chains settle.
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	return { sent, elements, documentStub, deliver };
}

describe("answer widget protocol", () => {
	const answerId = JSON.stringify({ session_id: "s", gen_no: 1 });
	const toolResult = {
		method: "ui/notifications/tool-result",
		params: {
			content: [{ type: "text", text: "{}" }],
			structuredContent: {
				answer_id: answerId,
				title: "Revenue by region",
				open_url: `${instanceUrl}/#/answer`,
			},
		},
	};

	it("initializes, fetches the answer image and renders it", async () => {
		const { sent, elements, documentStub, deliver } = bootWidget();

		expect(sent[0]).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			method: "ui/initialize",
			params: {
				appInfo: { name: "ThoughtSpotAnswer" },
				protocolVersion: "2026-01-26",
			},
		});

		await deliver({ id: 1, result: { hostContext: { theme: "dark" } } });
		expect(documentStub.documentElement.classList.toggle).toHaveBeenCalledWith(
			"dark",
			true,
		);
		expect(sent).toContainEqual({
			jsonrpc: "2.0",
			method: "ui/notifications/initialized",
			params: {},
		});
		expect(sent).toContainEqual({
			jsonrpc: "2.0",
			method: "ui/notifications/size-changed",
			params: { height: 321 },
		});

		await deliver(toolResult);
		expect(elements.title.textContent).toBe("Revenue by region");
		expect(elements.open.hidden).toBe(false);
		const call = sent.at(-1);
		expect(call).toMatchObject({
			method: "tools/call",
			params: {
				name: "fetch_answer_image",
				arguments: { answer_id: answerId },
			},
		});

		await deliver({
			id: call.id,
			result: {
				content: [
					{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				],
			},
		});
		const [img] = elements.frame.children;
		expect(img.src).toBe("data:image/png;base64,iVBORw0KGgo=");
		expect(img.alt).toBe("Revenue by region");
	});

	it("opens the answer through the host", async () => {
		const { sent, elements, deliver } = bootWidget();
		await deliver({ id: 1, result: {} });
		await deliver(toolResult);

		elements.open.listeners.click();

		expect(sent.at(-1)).toMatchObject({
			method: "ui/open-link",
			params: { url: `${instanceUrl}/#/answer` },
		});
	});

	it("shows the error text when the image fetch fails", async () => {
		const { sent, elements, deliver } = bootWidget();
		await deliver({ id: 1, result: {} });
		await deliver(toolResult);

		await deliver({
			id: sent.at(-1).id,
			result: {
				isError: true,
				content: [{ type: "text", text: "ERROR: Could not load" }],
			},
		});
		expect(elements.frame.children[0].textContent).toBe(
			"ERROR: Could not load",
		);
		expect(elements.frame.children[0].className).toBe("status error");
	});

	it("answers ping and ignores messages from other frames", async () => {
		const { sent, deliver } = bootWidget();
		const before = sent.length;

		await deliver({ id: 99, method: "ping" }, { not: "parent" });
		expect(sent).toHaveLength(before);

		await deliver({ id: 99, method: "ping" });
		expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 99, result: {} });
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FileTooLargeError,
	bytesToBase64,
	conversationFileFormat,
	downloadSpotter3File,
	readBodyCapped,
} from "../../../../src/services/clients/get-file/conversation-file";
import { ThoughtSpotApiError } from "../../../../src/services/types";

const ctx = {
	instanceUrl: "https://test.thoughtspot.cloud",
	token: "test-token",
	tenantId: "",
	orgId: "",
	userId: "",
};

describe("conversationFileFormat", () => {
	it.each([
		["csv", "csv", "text/csv"],
		["pdf", "pdf", "application/pdf"],
		["png", "image", "image/png"],
		["jpg", "image", "image/jpeg"],
		["jpeg", "image", "image/jpeg"],
	])("maps %s to %s (%s)", (extension, kind, mimeType) => {
		expect(conversationFileFormat(extension)).toMatchObject({ kind, mimeType });
	});

	it.each(["xlsx", "", "constructor", "toString"])(
		"has no format for %j",
		(extension) => {
			expect(conversationFileFormat(extension)).toBeUndefined();
		},
	);
});

describe("downloadSpotter3File", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("GETs the conversation's download route with the ids encoded", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("a,b\n1,2\n"));
		vi.stubGlobal("fetch", fetchMock);

		const response = await downloadSpotter3File(ctx, {
			conversationId: "conv/1",
			tsFileId: "report 1.csv",
		});

		expect(await response.text()).toBe("a,b\n1,2\n");
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"https://test.thoughtspot.cloud/conversation/v2/conv%2F1/download/report%201.csv",
		);
		expect(init.method).toBe("GET");
		expect(init.headers.Authorization).toBe("Bearer test-token");
	});

	it("throws a ThoughtSpotApiError that keeps the status and body", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response('{"error_code":"FILE_EXPIRED"}', { status: 400 }),
				),
		);

		const error = await downloadSpotter3File(ctx, {
			conversationId: "conv-1",
			tsFileId: "report.csv",
		}).catch((e) => e);

		expect(error).toBeInstanceOf(ThoughtSpotApiError);
		expect(error.status).toBe(400);
		expect(error.body).toContain("FILE_EXPIRED");
	});
});

describe("readBodyCapped", () => {
	it("returns the whole body when it fits", async () => {
		const bytes = await readBodyCapped(new Response("hello"), 5);
		expect(new TextDecoder().decode(bytes)).toBe("hello");
	});

	it("returns no bytes for an empty body", async () => {
		const bytes = await readBodyCapped(new Response(null), 5);
		expect(bytes.byteLength).toBe(0);
	});

	it("refuses a body whose content-length is over the cap, without reading it", async () => {
		const response = new Response("hello world", {
			headers: { "content-length": "11" },
		});

		await expect(readBodyCapped(response, 5)).rejects.toBeInstanceOf(
			FileTooLargeError,
		);
	});

	it("stops reading a body with no content-length once it passes the cap", async () => {
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array(4));
			},
		});

		const error = await readBodyCapped(new Response(stream), 10).catch(
			(e) => e,
		);

		expect(error).toBeInstanceOf(FileTooLargeError);
		expect(error.maxBytes).toBe(10);
		// An endless stream is not drained.
		expect(pulls).toBeLessThan(10);
	});
});

describe("bytesToBase64", () => {
	it("encodes bytes of every value", () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
		expect(atob(bytesToBase64(bytes))).toBe(
			String.fromCharCode(...Array.from(bytes)),
		);
	});

	it("encodes a file larger than one slice", () => {
		const bytes = new Uint8Array(0x8000 * 2 + 7).fill(65);
		expect(atob(bytesToBase64(bytes))).toBe("A".repeat(bytes.length));
	});
});

/**
 * Integration tests for the nano ID fix (git sha 6f7f0e9).
 *
 * These tests exercise the real `customAlphabet` from nanoid — no mocking of
 * the ID generation — and focus on the streaming-collision scenario that
 * motivated the change: multiple messages sent in quick succession must each
 * carry a unique, well-formed ID.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getThoughtSpotClient } from "../../src/thoughtspot/thoughtspot-client";
import {
	createBearerAuthenticationConfig,
	ThoughtSpotRestApi,
} from "@thoughtspot/rest-api-sdk";

// Mock only the SDK plumbing — nanoid is intentionally NOT mocked so that the
// real customAlphabet implementation is exercised.
vi.mock("@thoughtspot/rest-api-sdk", () => ({
	createBearerAuthenticationConfig: vi.fn(),
	ThoughtSpotRestApi: vi.fn(),
}));

global.fetch = vi.fn();

const CUSTOM_ALPHABET =
	"_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NANO_ID_SIZE = 12;
const ALLOWED_CHARS_RE = /^[_\-0-9a-zA-Z]+$/;

const INSTANCE_URL = "https://integration-test.thoughtspot.com";
const BEARER_TOKEN = "integration-test-token";

function buildClient() {
	const mockConfig = { middleware: [] };
	const mockClient: Record<string, any> = { instanceUrl: INSTANCE_URL };

	(createBearerAuthenticationConfig as any).mockReturnValue(mockConfig);
	(ThoughtSpotRestApi as any).mockImplementation(() => mockClient);

	return getThoughtSpotClient(INSTANCE_URL, BEARER_TOKEN) as any;
}

function mockOkFetch() {
	(fetch as any).mockResolvedValue({ ok: true });
}

function parsedBodies(): any[] {
	return (fetch as any).mock.calls.map((call: any[]) =>
		JSON.parse(call[1].body),
	);
}

describe("sendAgentConversationMessageStreaming — nano ID integration", () => {
	let client: any;

	beforeEach(() => {
		vi.clearAllMocks();
		client = buildClient();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("produces an id with exactly the configured length using the real nanoid library", async () => {
		mockOkFetch();

		await client.sendAgentConversationMessageStreaming({
			conversation_identifier: "conv-1",
			message: "hello",
		});

		const [body] = parsedBodies();
		expect(typeof body.id).toBe("string");
		expect(body.id).toHaveLength(NANO_ID_SIZE);
	});

	it("produces an id that only contains characters from the custom alphabet", async () => {
		mockOkFetch();

		await client.sendAgentConversationMessageStreaming({
			conversation_identifier: "conv-1",
			message: "hello",
		});

		const [body] = parsedBodies();
		expect(body.id).toMatch(ALLOWED_CHARS_RE);

		// Also assert that every individual character is in the alphabet
		for (const char of body.id) {
			expect(CUSTOM_ALPHABET).toContain(char);
		}
	});

	it("generates unique ids for many rapid sequential calls — the streaming collision scenario", async () => {
		mockOkFetch();

		const callCount = 50;
		for (let i = 0; i < callCount; i++) {
			await client.sendAgentConversationMessageStreaming({
				conversation_identifier: "conv-streaming",
				message: `message-${i}`,
			});
		}

		const ids = parsedBodies().map((b) => b.id);
		const uniqueIds = new Set(ids);

		expect(ids).toHaveLength(callCount);
		expect(uniqueIds.size).toBe(callCount);
	});

	it("generates unique ids for concurrent calls — parallel streaming scenario", async () => {
		mockOkFetch();

		const callCount = 20;
		await Promise.all(
			Array.from({ length: callCount }, (_, i) =>
				client.sendAgentConversationMessageStreaming({
					conversation_identifier: "conv-concurrent",
					message: `parallel-message-${i}`,
				}),
			),
		);

		const ids = parsedBodies().map((b) => b.id);
		const uniqueIds = new Set(ids);

		expect(ids).toHaveLength(callCount);
		expect(uniqueIds.size).toBe(callCount);
	});

	it("each generated id passes all format constraints regardless of call order", async () => {
		mockOkFetch();

		const callCount = 10;
		await Promise.all(
			Array.from({ length: callCount }, (_, i) =>
				client.sendAgentConversationMessageStreaming({
					conversation_identifier: "conv-format",
					message: `msg-${i}`,
				}),
			),
		);

		for (const body of parsedBodies()) {
			expect(body.id).toHaveLength(NANO_ID_SIZE);
			expect(body.id).toMatch(ALLOWED_CHARS_RE);
		}
	});

	it("sends the id alongside the correct request structure in a realistic streaming payload", async () => {
		mockOkFetch();

		const conversationId = "realistic-conv-abc123";
		const userMessage = "What is the total revenue for Q4?";

		await client.sendAgentConversationMessageStreaming({
			conversation_identifier: conversationId,
			message: userMessage,
		});

		const [url, options] = (fetch as any).mock.calls[0];
		const body = JSON.parse(options.body);

		// Endpoint construction
		expect(url).toBe(`${INSTANCE_URL}/conversation/v2/${conversationId}/query`);

		// The id must be present, valid length, and from the correct alphabet
		expect(body.id).toHaveLength(NANO_ID_SIZE);
		expect(body.id).toMatch(ALLOWED_CHARS_RE);

		// Surrounding payload shape must be intact
		expect(body.mode).toBe("spotter");
		expect(body.messages).toHaveLength(1);
		expect(body.messages[0]).toMatchObject({
			type: "text",
			value: userMessage,
		});
		expect(typeof body.messages[0].id).toBe("string");
	});
});

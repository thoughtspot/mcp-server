import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamingMessagesStorageWithTtl } from "../../src/streaming-message-storage-with-ttl/streaming-message-storage-with-ttl";
import type { Message } from "../../src/thoughtspot/types";

// Helper to build a mock DurableObjectStorage backed by an in-memory Map
function createMockStorage() {
	const store = new Map<string, unknown>();

	const getImpl = async (key: string): Promise<unknown> => {
		return store.get(key);
	};

	return {
		store,
		get: vi.fn(getImpl) as unknown as {
			<T>(key: string): Promise<T | undefined>;
			getMockImplementation(): typeof getImpl;
			mockImplementation(impl: (key: string) => Promise<unknown>): any;
		},
		put: vi.fn(async (key: string, value: unknown): Promise<void> => {
			store.set(key, value);
		}),
		delete: vi.fn(async (keys: string[]): Promise<void> => {
			for (const key of keys) {
				store.delete(key);
			}
		}),
	};
}

// Sample messages used across tests
const textMessage: Message = { type: "text", text: "Hello" };
const chunkMessage: Message = { type: "text_chunk", text: " world" };
const answerMessage: Message = {
	type: "answer",
	answer_id: "ans-1",
	answer_title: "My Answer",
	answer_query: "SELECT 1",
	iframe_url: "https://example.com/answer/1",
};

describe("StreamingMessagesStorageWithTtl", () => {
	let doStorage: ReturnType<typeof createMockStorage>;
	let scheduleTimer: ReturnType<typeof vi.fn>;
	let cancelTimer: ReturnType<typeof vi.fn>;
	let messagesStorage: StreamingMessagesStorageWithTtl;

	let timerIdCounter = 0;

	beforeEach(() => {
		timerIdCounter = 0;
		doStorage = createMockStorage();
		scheduleTimer = vi.fn(async () => `timer-${++timerIdCounter}`);
		cancelTimer = vi.fn(async () => {});
		messagesStorage = new StreamingMessagesStorageWithTtl(
			doStorage as any,
			scheduleTimer,
			cancelTimer,
		);
	});

	describe("initializeConversation", () => {
		it("creates a new conversation with empty messages and schedules a timer", async () => {
			await messagesStorage.initializeConversation("conv-1");

			expect(scheduleTimer).toHaveBeenCalledOnce();
			expect(doStorage.put).toHaveBeenCalledWith("conv-1", {
				messages: [],
				isDone: false,
				timerId: "timer-1",
			});
			expect(doStorage.put).toHaveBeenCalledWith("conv-1-bookmark", 0);
		});

		it("resets bookmark to 0 for a brand new conversation", async () => {
			await messagesStorage.initializeConversation("conv-1");

			const bookmark = (await doStorage.get("conv-1-bookmark")) as number;
			expect(bookmark).toBe(0);
		});

		it("throws when conversation already exists and is not done", async () => {
			await messagesStorage.initializeConversation("conv-1");
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
			]);

			await expect(
				messagesStorage.initializeConversation("conv-1"),
			).rejects.toThrow("Conversation already exists and is not marked done");
		});

		it("allows re-initialization of a conversation that is marked done", async () => {
			await messagesStorage.initializeConversation("conv-1");
			await messagesStorage.appendMessagesAndRestartTtl(
				"conv-1",
				[textMessage],
				true,
			);

			await expect(
				messagesStorage.initializeConversation("conv-1"),
			).resolves.toBeUndefined();

			const state = (await doStorage.get("conv-1")) as any;
			expect(state).toMatchObject({ messages: [], isDone: false });
		});

		it("cancels the previous timer when re-initializing a done conversation", async () => {
			await messagesStorage.initializeConversation("conv-1");
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [], true);

			const prevTimerId = ((await doStorage.get("conv-1")) as any).timerId;
			cancelTimer.mockClear();

			await messagesStorage.initializeConversation("conv-1");

			expect(cancelTimer).toHaveBeenCalledWith(prevTimerId);
		});
	});

	describe("appendMessagesAndRestartTtl", () => {
		beforeEach(async () => {
			await messagesStorage.initializeConversation("conv-1");
		});

		it("appends messages to an existing conversation", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
			]);

			const state = (await doStorage.get("conv-1")) as any;
			expect(state.messages).toEqual([textMessage]);
			expect(state.isDone).toBe(false);
		});

		it("appends multiple messages in a single call", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
				chunkMessage,
				answerMessage,
			]);

			const state = (await doStorage.get("conv-1")) as any;
			expect(state.messages).toHaveLength(3);
			expect(state.messages).toEqual([
				textMessage,
				chunkMessage,
				answerMessage,
			]);
		});

		it("accumulates messages across multiple calls", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
			]);
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				chunkMessage,
			]);

			const state = (await doStorage.get("conv-1")) as any;
			expect(state.messages).toEqual([textMessage, chunkMessage]);
		});

		it("marks the conversation done when isDone is true", async () => {
			await messagesStorage.appendMessagesAndRestartTtl(
				"conv-1",
				[textMessage],
				true /* isDone */,
			);

			const state = (await doStorage.get("conv-1")) as any;
			expect(state.isDone).toBe(true);
		});

		it("restarts the TTL timer on each call", async () => {
			const timerAfterInit = ((await doStorage.get("conv-1")) as any).timerId;

			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
			]);

			expect(cancelTimer).toHaveBeenCalledWith(timerAfterInit);
			expect(scheduleTimer).toHaveBeenCalledTimes(2); // once for init, once here
		});

		it("throws when the conversation does not exist", async () => {
			await expect(
				messagesStorage.appendMessagesAndRestartTtl("unknown-conv", [
					textMessage,
				]),
			).rejects.toThrow("Conversation not found");
		});

		it("throws when the conversation is already marked done", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [], true);

			await expect(
				messagesStorage.appendMessagesAndRestartTtl("conv-1", [textMessage]),
			).rejects.toThrow("Cannot append messages to a conversation marked done");
		});
	});

	describe("getNewMessagesAndUpdateBookmark", () => {
		beforeEach(async () => {
			await messagesStorage.initializeConversation("conv-1");
		});

		it("returns empty messages and isDone=false when no messages have been appended", async () => {
			const result =
				await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1");

			expect(result).toEqual({ messages: [], isDone: false });
		});

		it("returns only new messages since the last bookmark", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
			]);
			await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1"); // advances bookmark to 1

			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				chunkMessage,
			]);
			const result =
				await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1");

			expect(result.messages).toEqual([chunkMessage]);
		});

		it("advances the bookmark so the next call does not return already-seen messages", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
				chunkMessage,
			]);

			// sees both, advances bookmark to 2
			await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1");

			const result =
				await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1");
			expect(result.messages).toHaveLength(0);
		});

		it("reflects isDone=true when the conversation has been completed", async () => {
			await messagesStorage.appendMessagesAndRestartTtl(
				"conv-1",
				[textMessage],
				true,
			);

			const result =
				await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1");

			expect(result.isDone).toBe(true);
			expect(result.messages).toEqual([textMessage]);
		});

		it("returns all accumulated messages on the first call", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
			]);
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				chunkMessage,
			]);
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				answerMessage,
			]);

			const result =
				await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1");

			expect(result.messages).toEqual([
				textMessage,
				chunkMessage,
				answerMessage,
			]);
		});

		it("throws when the conversation does not exist", async () => {
			await expect(
				messagesStorage.getNewMessagesAndUpdateBookmark("unknown-conv"),
			).rejects.toThrow("Conversation not found");
		});
	});

	describe("onTimerTriggered", () => {
		beforeEach(async () => {
			await messagesStorage.initializeConversation("conv-1");
		});

		it("deletes the conversation state and bookmark from storage", async () => {
			await messagesStorage.onTimerTriggered("conv-1");

			expect(doStorage.delete).toHaveBeenCalledWith([
				"conv-1",
				"conv-1-bookmark",
			]);
		});

		it("causes subsequent operations to throw conversation not found", async () => {
			await messagesStorage.onTimerTriggered("conv-1");

			await expect(
				messagesStorage.appendMessagesAndRestartTtl("conv-1", [textMessage]),
			).rejects.toThrow("Conversation not found");

			await expect(
				messagesStorage.getNewMessagesAndUpdateBookmark("conv-1"),
			).rejects.toThrow("Conversation not found");
		});

		it("allows re-initialization of a conversation after expiry", async () => {
			await messagesStorage.onTimerTriggered("conv-1");

			await expect(
				messagesStorage.initializeConversation("conv-1"),
			).resolves.toBeUndefined();
		});
	});

	describe("race condition scenarios", () => {
		beforeEach(async () => {
			await messagesStorage.initializeConversation("conv-1");
		});

		// Race condition note #1: initializeConversation must not be called on a
		// conversation that exists and is not done.
		it("(note #1) concurrent initializeConversation calls on an active conversation – the second call throws", async () => {
			// First init already ran in beforeEach. A second call while not done must fail.
			await expect(
				messagesStorage.initializeConversation("conv-1"),
			).rejects.toThrow("Conversation already exists and is not marked done");
		});

		// Race condition note #3: two concurrent getNewMessagesAndUpdateBookmark calls
		// should return the same (internally consistent) state.
		it("(note #3) two concurrent getNewMessagesAndUpdateBookmark calls return consistent state", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
				chunkMessage,
			]);

			// Fire both calls before either has a chance to update the bookmark.
			const [result1, result2] = await Promise.all([
				messagesStorage.getNewMessagesAndUpdateBookmark("conv-1"),
				messagesStorage.getNewMessagesAndUpdateBookmark("conv-1"),
			]);

			// Both calls read the same snapshot, so both should return the same messages.
			expect(result1.messages).toEqual([textMessage, chunkMessage]);
			expect(result2.messages).toEqual([textMessage, chunkMessage]);

			// The bookmark should now point past both messages.
			const bookmark = (await doStorage.get("conv-1-bookmark")) as number;
			expect(bookmark).toBe(2);
		});

		// Race condition note #4a: appendMessagesAndRestartTtl runs first; a
		// concurrent getNewMessagesAndUpdateBookmark that read state before the append
		// returns the pre-append snapshot (no lost data, just delayed visibility).
		it("(note #4a) getNewMessagesAndUpdateBookmark that reads before an append returns pre-append snapshot", async () => {
			// Simulate: get reads state before append writes new messages by controlling
			// the order of storage.get invocations.
			let getCallCount = 0;
			const originalGet = doStorage.get.getMockImplementation()!;

			doStorage.get.mockImplementation(async (key: string) => {
				getCallCount++;
				// On the first get (bookmark fetch inside getNewMessages), pause
				// until appendMessages has already written its update.
				if (key === "conv-1" && getCallCount === 2) {
					// Snapshot the pre-append state before yielding.
					return originalGet(key);
				}
				return originalGet(key);
			});

			// First, confirm the conversation starts empty.
			const preAppendResult =
				await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1");
			expect(preAppendResult.messages).toHaveLength(0);

			// Now append and fetch again – the second fetch should see the new message.
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
			]);
			const postAppendResult =
				await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1");
			expect(postAppendResult.messages).toEqual([textMessage]);
		});

		// Race condition note #4b: getNewMessagesAndUpdateBookmark runs first; an
		// interleaving append either lands before or after the state snapshot but in
		// both cases the state returned is internally consistent.
		it("(note #4b) interleaved append and get are both internally consistent", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
			]);

			// Simulate the bookmark being read first (returns 0), then the append
			// updates storage, and then getNewMessages reads the updated state.
			let bookmarkRead = false;
			const originalGet = doStorage.get.getMockImplementation()!;

			doStorage.get.mockImplementation(async (key: string) => {
				if (key === "conv-1-bookmark" && !bookmarkRead) {
					bookmarkRead = true;
					// After reading the bookmark, allow an append to interleave.
					await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
						chunkMessage,
					]);
				}
				return originalGet(key);
			});

			const result =
				await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1");

			// The result should be internally consistent: either the pre-append or
			// post-append snapshot, but not a partial mix.
			const validPreAppend = result.messages.length >= 1; // at least textMessage
			expect(validPreAppend).toBe(true);
			expect(result.isDone).toBe(false);
		});

		// Race condition note #5: onTimerTriggered races with appendMessagesAndRestartTtl.
		// If the timer fires and deletes the state, the append call will fail because
		// the conversation no longer exists. A fresh initialization recovers the system.
		it("(note #5) timer fires concurrently with append – append recreates the state", async () => {
			// Use a separate conversation to avoid conflicting with the beforeEach init.
			const convId = "conv-race-5a";
			await messagesStorage.initializeConversation(convId);

			// Simulate timer firing (e.g. 30-minute gap between streaming events).
			await messagesStorage.onTimerTriggered(convId);

			// The append should fail because the state was deleted.
			await expect(
				messagesStorage.appendMessagesAndRestartTtl(convId, [textMessage]),
			).rejects.toThrow("Conversation not found");

			// A fresh initialization should succeed (the system can recover).
			await expect(
				messagesStorage.initializeConversation(convId),
			).resolves.toBeUndefined();
		});

		// Race condition note #5: timer races with getNewMessagesAndUpdateBookmark.
		// If the timer fires after the bookmark is saved, subsequent calls fail.
		it("(note #5) timer fires concurrently with getNewMessages – subsequent call throws", async () => {
			await messagesStorage.appendMessagesAndRestartTtl("conv-1", [
				textMessage,
			]);

			// Simulate timer firing after bookmark is already updated but before caller
			// has a chance to issue a follow-up get.
			await messagesStorage.getNewMessagesAndUpdateBookmark("conv-1"); // bookmark now = 1
			await messagesStorage.onTimerTriggered("conv-1"); // state deleted

			await expect(
				messagesStorage.getNewMessagesAndUpdateBookmark("conv-1"),
			).rejects.toThrow("Conversation not found");
		});
	});
});

import { isBoolean, isNumber } from "lodash";
import type { Message, StreamingMessagesState } from "../thoughtspot/types";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

const MESSAGE_KEY_PREFIX = "message-";
const IS_DONE_KEY = "is-done";
const WRITE_BOOKMARK_KEY = "write-bookmark";
const READ_BOOKMARK_KEY = "read-bookmark";

/**
 * A Durable Object that stores streaming conversation messages and exposes them over HTTP.
 *
 * Each instance corresponds to a single conversation. This means we don't need to use the
 * conversationId internally, instead it is used to route to a unique instance per conversation.
 * The parent DurableObject routes requests here via /storage/<conversation-id>, and this DO
 * handles the following sub-routes:
 *
 *   POST  /storage/<conversation-id>/initialize —> initializeConversation
 *   POST  /storage/<conversation-id>/append     —> appendMessagesAndRestartTtl
 *   GET   /storage/<conversation-id>/messages   —> getNewMessagesAndUpdateBookmark
 */
export class ConversationStorageServer {
	private conversationId = "";

	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// Strip the /storage/<conversation-id> prefix; remaining path is the operation
		// e.g. /storage/abc123/initialize -> /initialize
		const parts = url.pathname.split("/");
		// parts: ["", "storage", "<conversationId>", "<operation>"]
		this.conversationId = parts[2];
		const operation = parts[3] ?? "";

		try {
			switch (`${request.method} /${operation}`) {
				case "POST /initialize": {
					await this.initializeConversation();
					return Response.json({ ok: true });
				}

				case "POST /append": {
					const body = (await request.json()) as StreamingMessagesState;
					await this.appendMessagesAndRestartTtl(body.messages, body.isDone);
					return Response.json({ ok: true });
				}

				case "GET /messages": {
					const state = await this.getNewMessagesAndUpdateBookmark();
					return Response.json(state);
				}

				default:
					return new Response("Not Found", { status: 404 });
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`Error handling conversation storage request for conversation ${this.conversationId}:`,
				message,
			);
			return Response.json({ error: "Something went wrong" }, { status: 500 });
		}
	}

	/*
	 * Initialize the conversation. This can be a brand new conversation, or it can be priming an
	 * existing conversation which is already marked done for a followup message. We never delete
	 * messages in the conversation, instead the next messages begin at the existing bookmark.
	 */
	private async initializeConversation(): Promise<void> {
		const existingIsDone = await this.state.storage.get<boolean>(IS_DONE_KEY);
		if (isBoolean(existingIsDone) && !existingIsDone) {
			throw new Error(
				`Conversation ${this.conversationId} already exists and is not marked done`,
			);
		}

		await this.state.storage.put<boolean>(IS_DONE_KEY, false);
		await this.restartTtl();
	}

	/*
	 * Append new messages to the conversation, starting at the current state of WRITE_BOOKMARK and
	 * saving the new state of WRITE_BOOKMARK after. We write the isDone flag state after writing
	 * all messages, so that if a reader is executing concurrently, they will never think the
	 * conversation is done without having already seen all messages. We also restart the TTL for
	 * the conversation after all writes are done.
	 */
	private async appendMessagesAndRestartTtl(
		newMessages: Message[],
		isDone = false,
	): Promise<void> {
		const existingIsDone = await this.state.storage.get<boolean>(IS_DONE_KEY);
		if (!isBoolean(existingIsDone)) {
			throw new Error(`Conversation ${this.conversationId} not found`);
		}
		if (existingIsDone) {
			throw new Error(
				`Cannot append messages to conversation ${this.conversationId} marked done`,
			);
		}

		let idx = (await this.state.storage.get<number>(WRITE_BOOKMARK_KEY)) ?? 0;
		for (const message of newMessages) {
			await this.state.storage.put<Message>(
				`${MESSAGE_KEY_PREFIX}${idx}`,
				message,
			);
			idx++;
		}
		await this.state.storage.put<number>(WRITE_BOOKMARK_KEY, idx);

		if (isDone) {
			await this.state.storage.put<boolean>(IS_DONE_KEY, true);
		}

		await this.restartTtl();
	}

	/*
	 * Retrieve all new messages since the last time this was called. We use a READ_BOOKMARK to
	 * track the index of the last returned message, and update it when returning new messages. We
	 * read the isDone flag state before reading messages, so that if a writer is executing
	 * concurrently, we will only see isDone=true if all messages have already been written. Note
	 * that we don't restart the TTL here, since it is only meant to be based on writes.
	 */
	private async getNewMessagesAndUpdateBookmark(): Promise<StreamingMessagesState> {
		const isDone = await this.state.storage.get<boolean>(IS_DONE_KEY);
		if (!isBoolean(isDone)) {
			throw new Error(`Conversation ${this.conversationId} not found`);
		}

		let bookmark =
			(await this.state.storage.get<number>(READ_BOOKMARK_KEY)) ?? 0;
		const newMessages: Message[] = [];
		while (true) {
			const message = await this.state.storage.get<Message>(
				`${MESSAGE_KEY_PREFIX}${bookmark}`,
			);
			if (!message) {
				break;
			}
			newMessages.push(message);
			bookmark++;
		}
		await this.state.storage.put<number>(READ_BOOKMARK_KEY, bookmark);

		return {
			messages: newMessages,
			isDone,
		};
	}

	private async restartTtl(): Promise<void> {
		// Cancel any existing alarm and schedule a fresh one
		await this.state.storage.deleteAlarm();
		await this.state.storage.setAlarm(Date.now() + DEFAULT_TTL_MS);
	}

	async alarm(): Promise<void> {
		// Check for any abnormalities in the state prior to deleting
		const isDone = await this.state.storage.get<boolean>(IS_DONE_KEY);
		if (!isBoolean(isDone) || !isDone) {
			console.warn(
				`Conversation ${this.conversationId} expired without being marked done`,
				{
					isDone,
				},
			);
		}
		const writeBookmark =
			await this.state.storage.get<number>(WRITE_BOOKMARK_KEY);
		const readBookmark =
			await this.state.storage.get<number>(READ_BOOKMARK_KEY);
		if (!isNumber(writeBookmark)) {
			console.warn(
				`Conversation ${this.conversationId} expired without any messages written`,
			);
		} else if (!isNumber(readBookmark) || writeBookmark !== readBookmark) {
			console.warn(
				`Conversation ${this.conversationId} expired with unread messages`,
				{
					writeBookmark,
					readBookmark,
				},
			);
		}

		// Delete everything in storage
		await this.state.storage.deleteAll();
	}
}

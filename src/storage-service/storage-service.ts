import {
	SpanKind,
	SpanStatusCode,
	context,
	propagation,
	trace,
} from "@opentelemetry/api";
import type {
	Message,
	RawMessage,
	StreamingMessagesState,
} from "../thoughtspot/types";

/**
 * Client for the ConversationStorageServer Durable Object.
 *
 * Communicates directly with the DO via its stub (bypassing the OAuth layer), mapping to the
 * following HTTP endpoints exposed by the server:
 *   POST  /storage/<storageId>/initialize —> initializeConversation
 *   POST  /storage/<storageId>/append     —> appendMessagesAndRestartTtl
 *   GET   /storage/<storageId>/messages   —> getNewMessagesAndUpdateBookmark
 *   POST  /storage/<storageId>/state      —> putSessionState
 *   GET   /storage/<storageId>/state      —> getSessionState
 *
 * The storageId is derived by taking a hash of the user's access token and combining it with the
 * conversationId, to ensure no users can access each other's conversations.
 */
// Open-ended per-session state; each flow owns its own keys.
export type ConversationMetadata = Record<string, unknown>;

export class StorageServiceClient {
	constructor(
		private readonly namespace: DurableObjectNamespace,
		private readonly accessTokenHashUrlSafe: string,
	) {}

	private headers(): HeadersInit {
		return {
			"Content-Type": "application/json",
			Accept: "application/json",
		};
	}

	private stubFor(conversationId: string): DurableObjectStub {
		const id = this.namespace.idFromName(
			`${this.accessTokenHashUrlSafe}:${conversationId}`,
		);
		return this.namespace.get(id);
	}

	// DO stubs ignore the hostname; we use a placeholder so the path is parsed correctly.
	private url(conversationId: string, operation: string): string {
		return `https://internal/storage/${encodeURIComponent(conversationId)}/${operation}`;
	}

	// Call the DO inside a client span, propagating the trace context so the DO's own spans join
	// the caller's trace
	private async fetchStorage(
		conversationId: string,
		operation: string,
		init: RequestInit,
	): Promise<Response> {
		const method = init.method ?? "GET";
		const tracer = trace.getTracer("thoughtspot-mcp-server");
		return tracer.startActiveSpan(
			`conversation-storage-${method.toLowerCase()}-${operation}`,
			{
				kind: SpanKind.CLIENT,
				attributes: {
					conversation_id: conversationId,
					"http.method": method,
					storage_operation: operation,
				},
			},
			async (span) => {
				const headers = new Headers(init.headers);
				propagation.inject(context.active(), headers, {
					set: (carrier, key, value) => carrier.set(key, value),
				});
				try {
					const response = await this.stubFor(conversationId).fetch(
						this.url(conversationId, operation),
						{ ...init, headers },
					);
					span.setAttribute("http.status_code", response.status);
					if (!response.ok) {
						span.setStatus({ code: SpanStatusCode.ERROR });
					}
					return response;
				} catch (err) {
					span.recordException(err as Error);
					span.setStatus({ code: SpanStatusCode.ERROR });
					throw err;
				} finally {
					span.end();
				}
			},
		);
	}

	/**
	 * Initialize a conversation. Must be called before appending messages.
	 * Can also be called on an existing conversation that is already marked done,
	 * to prime it for a follow-up message.
	 */
	async initializeConversation(conversationId: string): Promise<void> {
		const response = await this.fetchStorage(conversationId, "initialize", {
			method: "POST",
			headers: this.headers(),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`Failed to initialize conversation (${response.status}): ${body}`,
			);
		}
	}

	/**
	 * Append new messages to a conversation and restart its TTL.
	 * Optionally mark the conversation as done.
	 */
	async appendMessages(
		conversationId: string,
		messages: (Message | RawMessage)[],
		isDone = false,
	): Promise<void> {
		const body: StreamingMessagesState = { messages, isDone };

		const response = await this.fetchStorage(conversationId, "append", {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Failed to append messages (${response.status}): ${text}`,
			);
		}
	}

	/**
	 * Retrieve all messages that have been added since the last call to this method
	 * (tracked via a per-conversation bookmark) and advance the bookmark.
	 * Also returns whether the conversation has been marked done.
	 */
	async getNewMessages(
		conversationId: string,
	): Promise<StreamingMessagesState> {
		const response = await this.fetchStorage(conversationId, "messages", {
			method: "GET",
			headers: this.headers(),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to get messages (${response.status}): ${text}`);
		}

		return response.json() as Promise<StreamingMessagesState>;
	}

	/**
	 * Persist a conversation's scalar state as a single blob (overwrites). Used by flows that must
	 * carry state between tool calls — e.g. a Spotter Model session's transaction id and generation
	 * working set. The message stream is stored separately and is unaffected.
	 */
	async putSessionState<T>(conversationId: string, state: T): Promise<void> {
		const response = await this.fetchStorage(conversationId, "state", {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(state),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Failed to put session state (${response.status}): ${text}`,
			);
		}
	}

	// Retrieve a conversation's scalar state, or null if it does not exist / has expired.
	async getSessionState<T>(conversationId: string): Promise<T | null> {
		const response = await this.fetchStorage(conversationId, "state", {
			method: "GET",
			headers: this.headers(),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Failed to get session state (${response.status}): ${text}`,
			);
		}

		return response.json() as Promise<T | null>;
	}

	/*
	 * SpotterViz session state, stored in the same per-conversation `/state` slot that Spotter Model
	 * uses rather than a separate metadata route.
	 *
	 * Callers patch individual keys (the SSE drain patches `generationNumber` while the dashboard
	 * orchestrator writes turn progress), so these give merge semantics on top of the whole-blob
	 * put. Note this is read-modify-write across two DO calls, not atomic: two concurrent patches to
	 * the same session can lose one write. The previous dedicated PATCH route merged inside the DO.
	 */

	// Throws when nothing is stored, matching what callers expect from a missing session.
	async getMetadata<T extends ConversationMetadata = ConversationMetadata>(
		conversationId: string,
	): Promise<T> {
		const state = await this.getSessionState<T>(conversationId);
		if (state === null) {
			throw new Error(`No session state stored for ${conversationId}`);
		}
		return state;
	}

	// Shallow-merge a patch into the stored state and return the result.
	async updateMetadata<T extends ConversationMetadata = ConversationMetadata>(
		conversationId: string,
		patch: Partial<T>,
	): Promise<T> {
		const existing =
			(await this.getSessionState<T>(conversationId)) ?? ({} as T);
		const merged = { ...existing, ...patch } as T;
		await this.putSessionState<T>(conversationId, merged);
		return merged;
	}

	/*
	 * Type-generic twins of appendMessages / getNewMessages, for streams whose items are not Spotter
	 * messages (SpotterViz SSE events). They share the DO's message log and bookmark machinery.
	 */
	async appendEvents<T>(
		conversationId: string,
		events: T[],
		isDone = false,
	): Promise<void> {
		// Wire field stays "messages" so the DO route is shared between the two callers.
		const response = await this.fetchStorage(conversationId, "append", {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ messages: events, isDone }),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to append events (${response.status}): ${text}`);
		}
	}

	async getNewEvents<T>(
		conversationId: string,
	): Promise<{ messages: T[]; isDone: boolean }> {
		const response = await this.fetchStorage(conversationId, "messages", {
			method: "GET",
			headers: this.headers(),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to get events (${response.status}): ${text}`);
		}

		return response.json() as Promise<{ messages: T[]; isDone: boolean }>;
	}
}

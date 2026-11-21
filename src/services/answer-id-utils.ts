/**
 * The `answer_id` handed to the host agent for each Analytics Agent answer: a JSON string,
 * written here when a conversation stream yields an answer and read back by the tools that
 * take one (get_data, create_dashboard, modify_dashboard).
 *
 * `session_id` + `gen_no` name the answer for export and dashboards, but expire after about
 * 8 hours. `conversation_id` (plus `message_id` for Spotter 3) stays valid as long as the
 * conversation does and lets the answer be loaded again for fresh ids. SpotterX answers have
 * no message id, so an id with `conversation_id` and no `message_id` is a SpotterX one.
 */

/** How to load an answer again once its session ids expire */
export type AnswerReloadIds =
	// Reloaded through its conversation message
	| { kind: "spotter3"; conversationId: string; messageId: string }
	// Rebuilt from the recipe stored under its conversation
	| {
			kind: "spotterx";
			conversationId: string;
			sessionId: string;
			genNo: number;
	  };

export interface ParsedAnswerId {
	sessionIdentifier: string;
	generationNumber: number;
	// Absent for an `answer_id` issued before conversation ids were added
	reload?: AnswerReloadIds;
}

export function buildAnswerId(
	conversationId: string,
	item: { id?: string; metadata?: { session_id?: string; gen_no?: number } },
): string {
	return JSON.stringify({
		session_id: item.metadata?.session_id,
		gen_no: item.metadata?.gen_no,
		conversation_id: conversationId,
		message_id: item.id,
	});
}

/** Parse an `answer_id`. Undefined (and logged) when it is malformed. */
export function parseAnswerId(answerId: string): ParsedAnswerId | undefined {
	try {
		const { session_id, gen_no, conversation_id, message_id } =
			JSON.parse(answerId);
		if (session_id !== undefined && gen_no !== undefined) {
			return {
				sessionIdentifier: session_id,
				generationNumber: gen_no,
				reload: parseReloadIds(conversation_id, message_id, session_id, gen_no),
			};
		}
	} catch {
		// Logged below with the other malformed ids
	}
	console.error("Could not parse answer_id:", answerId);
	return undefined;
}

function parseReloadIds(
	conversationId: unknown,
	messageId: unknown,
	sessionId: unknown,
	genNo: unknown,
): AnswerReloadIds | undefined {
	if (typeof conversationId !== "string") {
		return undefined;
	}
	if (typeof messageId === "string") {
		return { kind: "spotter3", conversationId, messageId };
	}
	if (typeof sessionId === "string" && typeof genNo === "number") {
		return { kind: "spotterx", conversationId, sessionId, genNo };
	}
	return undefined;
}

import { context, trace } from "@opentelemetry/api";
import type { ThoughtSpotService } from "../services/thoughtspot-service";
import type { BachSession } from "../services/types";
import type { StorageServiceClient } from "../storage-service/storage-service";

/**
 * Per-chat state for a Spotter conversation, persisted in the conversation storage state slot
 * keyed by analytical_session_id. Add new optional fields here as needed; writes are shallow
 * merges, so each field is owned by the flow that writes it.
 */
export interface SpotterChatState extends Record<string, unknown> {
	// BACH pinboard sessions loaded for liveboards used as context, keyed by liveboard ID
	liveboardBachSessions?: Record<string, BachSession>;
}

/**
 * Get the BACH session for a liveboard used as context in a Spotter chat, reusing the one
 * stored in the chat state if present, otherwise creating and storing a new one. Must be
 * called after initializeConversation, which rejects concurrent sends to the same chat and so
 * guards the read-merge-write on the chat state.
 *
 * Note: technically it would be good to check if the session is expired before reusing, but
 * currently there is no good way to do that. Callosum keeps bach sessions for 8 hours so it's very
 * unlikely for this to expire sooner than the 30 min conversation window.
 */
export async function getOrCreateLiveboardBachSession(
	storageService: StorageServiceClient,
	thoughtSpotService: ThoughtSpotService,
	analyticalSessionId: string,
	liveboardId: string,
): Promise<BachSession> {
	const span = trace.getSpan(context.active());
	const chatState =
		await storageService.getSessionState<SpotterChatState>(analyticalSessionId);
	const storedSession = chatState?.liveboardBachSessions?.[liveboardId];
	span?.setAttribute("liveboard_bach_session_reused", !!storedSession);
	if (storedSession) {
		return storedSession;
	}

	const bachSession =
		await thoughtSpotService.createBachPinboardSession(liveboardId);
	await storageService.updateMetadata<SpotterChatState>(analyticalSessionId, {
		liveboardBachSessions: {
			...chatState?.liveboardBachSessions,
			[liveboardId]: bachSession,
		},
	});
	return bachSession;
}

/**
 * Constants for the Spotter Model (Lumos) flow.
 */

// Lumos's tenant-edge conversation routes: {instanceUrl}/lumos/api/v2/conversation/... . The Orion
// `/lumos` edge authenticates the bearer token and injects the identity Lumos requires
// (X-ThoughtSpot-Tenant-Id/-User-Id/-Orgs). No Prism proxy or public REST SDK is involved.
export const LUMOS_CONVERSATION_BASE = "/lumos/api/v2/conversation";

// The bach worksheet-editor endpoint used for the save and the model fetch (not a Lumos route).
export const WORKSHEET_OPERATION_ENDPOINT = "/prism/?op=WorksheetOperation";

// Mints a JSESSIONID from the bearer token; forwarded to Lumos for cookie-only backend tools.
export const SESSION_LOGIN_ENDPOINT = "/api/rest/2.0/auth/session/login";

// Long-poll cadence for a turn's updates. 120 × 500 ms ≈ 60 s per call: a model build runs 1–2 min
// and each MCP call carries ~10 s of connector overhead, so fewer/longer calls are faster overall.
// A call that outruns the connector timeout is killed, so this stays well inside it.
export const MODEL_POLL_ITERATIONS = 120;
export const MODEL_POLL_INTERVAL_MS = 500;

// Section headings that mark a Model Requirements Document. The MRD is not a distinct Lumos event
// — it arrives as MESSAGE_DELTA markdown — so we detect it by these headings.
export const MRD_MARKERS = [
	/model requirements/i,
	/key entities/i,
	/key analyses/i,
	// Colon-anchored so these single words only match as section HEADINGS ("Goal:",
	// "**Metrics**:") and never in running prose — "the goal is to track sales metrics" hits two
	// bare words, and looksLikeMrd needs only two to declare a plan awaiting approval. Matches the
	// shape extractMrdPlan already uses for its "Goal:" heading. Deliberately NOT anchored to a
	// line start: the plan arrives with <br> separators, so ^ in multiline mode may never match.
	/\bmetrics\b\s*\*{0,2}\s*:/i,
	/\bdimensions\b\s*\*{0,2}\s*:/i,
	/\bgoal\b\s*\*{0,2}\s*:/i,
];

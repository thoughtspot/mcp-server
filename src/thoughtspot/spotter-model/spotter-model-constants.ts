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
	/\bmetrics\b/i,
	/\bdimensions\b/i,
	/\bgoal\b/i,
];

// An unsaved answer from the Analytics Agent (Spotter), addressed by the
// `answer_id` that get_session_updates returns.
export const ANALYTICS_AGENT_ANSWER_TYPE = "ANALYTICS_AGENT_ANSWER";

// Object types get_data accepts as input — mirrors search_objects `type` (minus
// WORKSHEET, which has no saved data), plus ANALYTICS_AGENT_ANSWER. LIVEBOARD_VIZ
// resolves to the Liveboard endpoint. Single source for the Zod schema and the
// endpoint switch; keep the order, the REST client destructures it.
export const GET_DATA_SUPPORTED_TYPES = [
	"ANSWER",
	"LIVEBOARD",
	"LIVEBOARD_VIZ",
	ANALYTICS_AGENT_ANSWER_TYPE,
] as const;

// A saved object type the metadata data endpoints serve. ANALYTICS_AGENT_ANSWER is
// handled separately, through the answer's CSV export.
export type GetDataObjectType = Exclude<
	(typeof GET_DATA_SUPPORTED_TYPES)[number],
	typeof ANALYTICS_AGENT_ANSWER_TYPE
>;

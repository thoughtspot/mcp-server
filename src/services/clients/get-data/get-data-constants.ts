// An unsaved answer from the Analytics Agent (Spotter), addressed by the
// `answer_id` that get_session_updates returns.
export const SPOTTER_ANSWER_TYPE = "SPOTTER_ANSWER";

// Object types get_data accepts as input — mirrors search_objects `type` (minus
// WORKSHEET, which has no saved data), plus SPOTTER_ANSWER. LIVEBOARD_VIZ
// resolves to the Liveboard endpoint. Single source for the Zod schema and the
// endpoint switch; keep the order, the REST client destructures it.
export const GET_DATA_SUPPORTED_TYPES = [
	"ANSWER",
	"LIVEBOARD",
	"LIVEBOARD_VIZ",
	SPOTTER_ANSWER_TYPE,
] as const;

// A saved object type the metadata data endpoints serve. SPOTTER_ANSWER is
// handled separately, through the answer's CSV export.
export type GetDataObjectType = Exclude<
	(typeof GET_DATA_SUPPORTED_TYPES)[number],
	typeof SPOTTER_ANSWER_TYPE
>;

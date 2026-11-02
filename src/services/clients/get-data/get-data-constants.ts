// Object types get_data accepts as input — mirrors search_objects `type` (minus
// WORKSHEET, which has no saved data). LIVEBOARD_VIZ resolves to the Liveboard
// endpoint. Single source for the Zod schema and the endpoint switch.
export const GET_DATA_SUPPORTED_TYPES = [
	"ANSWER",
	"LIVEBOARD",
	"LIVEBOARD_VIZ",
] as const;

// One of the supported input types (not a bare string).
export type GetDataObjectType = (typeof GET_DATA_SUPPORTED_TYPES)[number];

// An unsaved answer from the Analytics Agent (Spotter), addressed by the
// `answer_id` that get_session_updates returns. Accepted only when the
// `enable-spotter-answer-data` (or `suppress-iframes`) URL flag is on.
export const SPOTTER_ANSWER_TYPE = "SPOTTER_ANSWER";

export const GET_DATA_WITH_SPOTTER_ANSWER_TYPES = [
	...GET_DATA_SUPPORTED_TYPES,
	SPOTTER_ANSWER_TYPE,
] as const;

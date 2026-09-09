// Object types get_data accepts as input — mirrors search_objects `type` (minus
// WORKSHEET, which has no saved data). LIVEBOARD_VIZ resolves to the Liveboard
// endpoint. Single source for the Zod schema and the endpoint switch.
export const GET_DATA_SUPPORTED_TYPES = [
	"ANSWER",
	"LIVEBOARD",
	"LIVEBOARD_VIZ",
] as const;

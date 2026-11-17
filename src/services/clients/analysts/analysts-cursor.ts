import { LIST_ANALYSTS_MAX_OFFSET } from "./analysts-constants";

// list_analysts cursors are the next record offset as a decimal string, matching search_objects.
// The backend caps record_offset, so a cursor past that cap is invalid rather than an upstream 4xx.

export function encodeAnalystsCursor(offset: number): string {
	return String(offset);
}

/** Returns the offset for a valid cursor, or undefined for anything that is not an integer in 0..LIST_ANALYSTS_MAX_OFFSET. */
export function decodeAnalystsCursor(cursor: string): number | undefined {
	if (!/^\d+$/.test(cursor)) {
		return undefined;
	}
	const offset = Number(cursor);
	return Number.isSafeInteger(offset) && offset <= LIST_ANALYSTS_MAX_OFFSET
		? offset
		: undefined;
}

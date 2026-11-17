// list_analysts cursors are the next record offset as a decimal string, matching search_objects.

export function encodeAnalystsCursor(offset: number): string {
	return String(offset);
}

/** Returns the offset for a valid cursor, or undefined for anything that is not a non-negative integer. */
export function decodeAnalystsCursor(cursor: string): number | undefined {
	if (!/^\d+$/.test(cursor)) {
		return undefined;
	}
	const offset = Number(cursor);
	return Number.isSafeInteger(offset) ? offset : undefined;
}

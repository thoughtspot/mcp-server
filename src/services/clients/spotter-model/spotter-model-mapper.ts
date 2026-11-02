/**
 * Pure transforms between upstream Spotter Model payloads and what the tools return / send.
 */

/**
 * Answer a pending clarification by cloning the choice envelope (echoed whole — no choice_id; bound
 * upstream by transaction_id + generation_no) and applying the selection, matching each option's
 * inner `id`. Two encodings by kind:
 *   - Flagged (table/column/join carry is_selected): keep all options, toggle is_selected.
 *   - Unflagged (formula): include ONLY the chosen options — injecting is_selected yields 0 formulas.
 * Returns undefined when nothing is pending, so the message is sent as plain text.
 */
export function buildChoiceAnswer(
	pendingChoice: Record<string, unknown> | null | undefined,
	selectedOptionIds: string[],
): Record<string, unknown> | undefined {
	if (!pendingChoice || typeof pendingChoice !== "object") {
		return undefined;
	}
	const selected = new Set(selectedOptionIds);
	// Deep clone so we never mutate the stored session state.
	const answer = JSON.parse(JSON.stringify(pendingChoice)) as Record<
		string,
		unknown
	>;
	const options = Array.isArray(answer.choice_options)
		? (answer.choice_options as Array<Record<string, unknown>>)
		: [];
	const innerOf = (
		option: Record<string, unknown>,
	): Record<string, unknown> | undefined => {
		const key = Object.keys(option)[0];
		const inner = key ? option[key] : undefined;
		return inner && typeof inner === "object"
			? (inner as Record<string, unknown>)
			: undefined;
	};
	// Flagged kinds carry a native is_selected; unflagged kinds (formulas) do not.
	const usesFlag = options.some((o) => {
		const inner = innerOf(o);
		return inner ? "is_selected" in inner : false;
	});
	if (usesFlag) {
		for (const option of options) {
			const inner = innerOf(option);
			if (inner && "id" in inner) {
				inner.is_selected = selected.has(String(inner.id));
			}
		}
	} else {
		answer.choice_options = options.filter((option) => {
			const inner = innerOf(option);
			return inner && "id" in inner && selected.has(String(inner.id));
		});
	}
	return answer;
}

/**
 * Render a clean, structured finalize summary from a fetchWorksheetModel response: counts of
 * tables/joins/columns (with table names). Returns null when the model is empty or the shape is
 * unrecognized, so the caller can fall back to a generic message.
 */
export function summarizeWorksheetModel(resp: any): string | null {
	const wm = resp?.data?.Worksheet__operation?.worksheetModel;
	if (!wm) return null;
	const tables = Array.isArray(wm.schemaGraphProto?.schemaTables)
		? wm.schemaGraphProto.schemaTables
		: [];
	const joins = Array.isArray(wm.schemaJoins) ? wm.schemaJoins : [];
	const columnGroups = Array.isArray(wm.columnGroup) ? wm.columnGroup : [];
	const columnCount = columnGroups.reduce(
		(n: number, g: any) =>
			n + (Array.isArray(g?.worksheetColumn) ? g.worksheetColumn.length : 0),
		0,
	);
	const names = tables
		.map((t: any) => t?.userDefinedName)
		.filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
	if (tables.length === 0 && joins.length === 0 && columnCount === 0) {
		return null;
	}
	const tablePart = names.length
		? `${tables.length} tables (${names.join(", ")})`
		: `${tables.length} tables`;
	return `${tablePart}, ${joins.length} joins, ${columnCount} columns.`;
}

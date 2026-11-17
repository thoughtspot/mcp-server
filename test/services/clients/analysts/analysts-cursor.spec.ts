import { describe, expect, it } from "vitest";
import {
	decodeAnalystsCursor,
	encodeAnalystsCursor,
} from "../../../../src/services/clients/analysts/analysts-cursor";

describe("analysts-cursor", () => {
	it.each([0, 20, 12345])("round-trips offset %d", (offset) => {
		expect(decodeAnalystsCursor(encodeAnalystsCursor(offset))).toBe(offset);
	});

	it.each(["", "abc", "-1", "1.5", " 5", "1e3", "99999999999999999999"])(
		"rejects invalid cursor %j",
		(cursor) => {
			expect(decodeAnalystsCursor(cursor)).toBeUndefined();
		},
	);
});

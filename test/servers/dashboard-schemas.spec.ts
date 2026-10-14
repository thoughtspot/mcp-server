/**
 * Guardrails on the dashboard tool schemas.
 *
 * These are asserted directly against the schemas rather than through a tool call because
 * mcp-testing-kit's `callTool` hangs on a JSON-RPC error response, so a thrown ZodError is not
 * observable through the harness.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	CreateDashboardInputSchema,
	CreateDashboardLegacyOutputSchema,
	CreateDashboardOutputSchema,
	GetDashboardStatusOutputSchema,
	ModifyDashboardInputSchema,
	ModifyDashboardOutputSchema,
} from "../../src/servers/tool-definitions";

const ANSWER = {
	answer_id: '{"session_id":"s","gen_no":2}',
	title: "Total sales by region",
};

describe("CreateDashboardInputSchema", () => {
	it("accepts answers with no design context, as existing callers send today", () => {
		const parsed = CreateDashboardInputSchema.parse({
			title: "Revenue",
			note_tile: "<p>hi</p>",
			answers: [ANSWER],
		});
		expect(parsed.answers).toHaveLength(1);
	});

	it("no longer requires note_tile, so a spec-driven dashboard need not invent one", () => {
		expect(() =>
			CreateDashboardInputSchema.parse({ title: "Revenue", answers: [ANSWER] }),
		).not.toThrow();
	});

	it("accepts a design context plus a data source with no answers", () => {
		const parsed = CreateDashboardInputSchema.parse({
			title: "Migrated dashboard",
			instructions: "KPI row on top, then a trend line by month",
			data_source_id: "ds-1",
		});
		expect(parsed.data_source_id).toBe("ds-1");
	});

	it("accepts a design context with no data source, so the designer can pick one", () => {
		const result = CreateDashboardInputSchema.safeParse({
			title: "Migrated dashboard",
			instructions: "KPI row on top",
		});
		expect(result.success).toBe(true);
	});

	// Requiring answers or instructions is enforced in the handler, where the calling agent sees
	// a readable error; a schema refinement would be dropped from the JSON Schema.
	it("leaves the answers-or-instructions rule to the handler", () => {
		expect(
			CreateDashboardInputSchema.safeParse({ title: "Empty" }).success,
		).toBe(true);
	});
});

describe("ModifyDashboardInputSchema", () => {
	it("accepts a dashboard id on its own", () => {
		expect(() =>
			ModifyDashboardInputSchema.parse({
				dashboard_id: "lb-1",
				instructions: "Use a dark theme",
			}),
		).not.toThrow();
	});

	it("accepts a dashboard id together with a task id, which is how a question gets answered", () => {
		expect(() =>
			ModifyDashboardInputSchema.parse({
				dashboard_id: "lb-1",
				task_id: "task-1",
				instructions: "Use the Retail data source",
			}),
		).not.toThrow();
	});

	it("hard rejects a call with no dashboard id, even when a task id is given", () => {
		// Every call must state which dashboard it is changing, so the target is never implied.
		for (const payload of [
			{ instructions: "x" },
			{ task_id: "task-1", instructions: "x" },
			{ dashboard_id: "", instructions: "x" },
		]) {
			expect(ModifyDashboardInputSchema.safeParse(payload).success).toBe(false);
		}
	});

	it("rejects empty instructions", () => {
		const result = ModifyDashboardInputSchema.safeParse({
			dashboard_id: "lb-1",
			instructions: "",
		});
		expect(result.success).toBe(false);
	});
});

describe("dashboard output schemas", () => {
	// The MCP SDK client validates structuredContent against outputSchema, and Zod emits closed
	// schemas, so an undeclared field is a runtime failure at a real client rather than in tests.
	it("shares one result shape across the new tools, with `link` only on the legacy tool", () => {
		const create = z.toJSONSchema(CreateDashboardOutputSchema) as any;
		const modify = z.toJSONSchema(ModifyDashboardOutputSchema) as any;
		const status = z.toJSONSchema(GetDashboardStatusOutputSchema) as any;
		const legacy = z.toJSONSchema(CreateDashboardLegacyOutputSchema) as any;

		expect(create.properties).toEqual(modify.properties);
		expect(status.properties).toEqual(modify.properties);
		expect(Object.keys(create.properties)).not.toContain("link");
		expect(Object.keys(create.properties)).toContain("message");
		for (const removed of [
			"summary",
			"question",
			"error",
			"steps",
			"events_seen",
		]) {
			expect(Object.keys(create.properties)).not.toContain(removed);
		}
		expect(Object.keys(legacy.properties)).toEqual(["link"]);
	});

	it("only requires `status`, so partial outcomes are representable", () => {
		const modify = z.toJSONSchema(ModifyDashboardOutputSchema) as any;
		expect(modify.required).toEqual(["status"]);
		expect(modify.additionalProperties).toBe(false);
	});

	it("accepts each of the four outcome shapes", () => {
		for (const payload of [
			{ status: "completed", dashboard_id: "lb", dashboard_url: "u" },
			{ status: "in_progress", task_id: "t", steps: ["Working"] },
			{ status: "needs_input", task_id: "t", question: "Which source?" },
			{ status: "failed", task_id: "t", error: "boom" },
		]) {
			expect(() => ModifyDashboardOutputSchema.parse(payload)).not.toThrow();
		}
	});
});

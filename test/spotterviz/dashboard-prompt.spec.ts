import { describe, expect, it } from "vitest";
import {
	DEFAULT_LAYOUT_REQUEST,
	composeCreatePrompt,
	composeModifyPrompt,
} from "../../src/spotterviz/dashboard-prompt";

describe("composeCreatePrompt", () => {
	it("asks for a data source and plan, without building, when there are no answers", () => {
		const prompt = composeCreatePrompt({
			title: "Sales",
			instructions: "Revenue by region",
			hasExistingAnswers: false,
		});

		expect(prompt).toContain("Do not create, change or publish anything");
		expect(prompt).toContain("the data source you chose");
		expect(prompt).toContain("Revenue by region");
		expect(prompt).not.toContain("publish them without asking");
	});

	it("builds directly when the charts already exist", () => {
		const prompt = composeCreatePrompt({
			title: "Sales",
			hasExistingAnswers: true,
		});

		expect(prompt).toContain("publish them without asking");
		expect(prompt).toContain(DEFAULT_LAYOUT_REQUEST);
		expect(prompt).not.toContain("Do not create, change or publish anything");
	});

	it("names the data source when one is given", () => {
		const prompt = composeCreatePrompt({
			title: "Sales",
			instructions: "x",
			dataSourceId: "ds-1",
			hasExistingAnswers: false,
		});

		expect(prompt).toContain("ds-1");
	});
});

describe("composeModifyPrompt", () => {
	it("builds autonomously, reusing the dashboard's data sources", () => {
		const prompt = composeModifyPrompt({ instructions: "Confirmed, build it" });

		expect(prompt).toContain("publish them without asking");
		expect(prompt).toContain("data sources those charts use");
		expect(prompt).toContain("Confirmed, build it");
	});
});

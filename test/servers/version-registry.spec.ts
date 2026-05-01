import { describe, it, expect } from "vitest";
import {
	resolveApiVersion,
	VERSION_REGISTRY,
} from "../../src/servers/version-registry";

// Helper: Validates if a given API version string is valid
function isValidApiVersion(apiVersion: string): boolean {
	try {
		resolveApiVersion(apiVersion);
		return true;
	} catch {
		return false;
	}
}

describe("Version Registry", () => {
	describe("resolveApiVersion", () => {
		it("should throw for null apiVersion", () => {
			expect(() => resolveApiVersion(null as any)).toThrow();
		});

		it("should return latest version when undefined is provided", () => {
			const result = resolveApiVersion(undefined);
			expect(result.version).toContain("latest");
		});

		it("should return beta version when 'beta' is specified", () => {
			const result = resolveApiVersion("beta");
			expect(result.version).toContain("beta");
		});

		it("should return latest stable version when 'latest' is specified", () => {
			const result = resolveApiVersion("latest");
			expect(result.version).toContain("latest");
			expect(result.version).not.toContain("beta");
		});

		it("should resolve exact date match", () => {
			const result = resolveApiVersion("2025-01-01");
			expect(result.version).toContain("2025-01-01");
		});

		it("should resolve to latest version on or before requested date", () => {
			const result = resolveApiVersion("2025-03-15");
			expect(result.version).toContain("2025-01-01");
		});

		it("should resolve to earlier version when requested date is between versions", () => {
			const result = resolveApiVersion("2025-01-01");
			expect(result.version).toContain("2025-01-01");
		});

		it("should return oldest version when date is before all versions", () => {
			// Use a date before the earliest version in VERSION_REGISTRY
			const result = resolveApiVersion("2020-01-01");
			expect(result.version).toContain("backwards-compatibility-default");
		});

		it("should exclude beta from date-based resolution", () => {
			// Beta versions should not be returned for date queries
			const result = resolveApiVersion("2025-03-01");
			expect(result.version).not.toContain("beta");
		});

		it("should throw for invalid date format", () => {
			expect(() => resolveApiVersion("invalid-date")).toThrow();
		});

		it("should throw for malformed date", () => {
			expect(() => resolveApiVersion("2025-13-01")).toThrow();
		});

		it("should throw for partial date", () => {
			expect(() => resolveApiVersion("2025-03")).toThrow();
		});

		it("should handle future dates", () => {
			const result = resolveApiVersion("2030-01-01");
			// Resolves to the latest dated stable entry
			expect(result.version).toContain("latest");
			expect(result.version).not.toContain("beta");
		});
	});

	describe("isValidApiVersion", () => {
		it("should return true for beta", () => {
			expect(isValidApiVersion("beta")).toBe(true);
		});

		it("should return true for valid date format", () => {
			expect(isValidApiVersion("2025-03-01")).toBe(true);
		});

		it("should return false for invalid format (throws)", () => {
			expect(isValidApiVersion("invalid")).toBe(false);
		});

		it("should return false for malformed date (throws)", () => {
			expect(isValidApiVersion("2025-13-45")).toBe(false);
		});

		it("should return false for partial date (throws)", () => {
			expect(isValidApiVersion("2025-03")).toBe(false);
		});
	});

	describe("getAvailableVersions", () => {
		it("should return all version identifiers", () => {
			const versions = VERSION_REGISTRY.flatMap((v) => v.version);
			expect(versions).toContain("beta");
			expect(versions).toContain("backwards-compatibility-default");
			expect(versions).toContain("latest");
			expect(versions).toContain("2025-01-01");
			expect(versions.length).toBeGreaterThan(0);
		});
	});

	describe("VERSION_REGISTRY", () => {
		it("should contain beta version", () => {
			const betaVersion = VERSION_REGISTRY.find((v) =>
				v.version.includes("beta"),
			);
			expect(betaVersion).toBeDefined();
			expect(betaVersion?.tools).toBeDefined();
		});

		it("should contain dated versions", () => {
			const datedVersions = VERSION_REGISTRY.filter(
				(v) => !v.version.includes("beta"),
			);
			expect(datedVersions.length).toBeGreaterThan(0);
		});

		it("should have tools defined for each version", () => {
			for (const version of VERSION_REGISTRY) {
				expect(version.tools).toBeDefined();
				expect(Array.isArray(version.tools)).toBe(true);
			}
		});

		it("should have valid version identifiers", () => {
			for (const version of VERSION_REGISTRY) {
				expect(version.version).toBeTruthy();
				expect(Array.isArray(version.version)).toBe(true);
				expect(version.version.length).toBeGreaterThan(0);
			}
		});
	});

	describe("Version comparison", () => {
		it("beta should resolve to Spotter3 tools", () => {
			const betaConfig = resolveApiVersion("beta");
			expect(betaConfig.version).toContain("beta");
			const toolNames = betaConfig.tools.map((t: any) => t.name);
			expect(toolNames).toContain("create_analysis_session");
			expect(toolNames).toContain("send_session_message");
			expect(toolNames).toContain("get_session_updates");
		});

		it("2024-12-01 should have base MCP tools without Spotter3", () => {
			const oldConfig = resolveApiVersion("2024-12-01");

			// Should have common tools + base MCP server tools (without Spotter3)
			expect(oldConfig.tools.length).toBeGreaterThan(0);

			// Check that it has getRelevantQuestions and getAnswer
			const toolNames = oldConfig.tools.map((t: any) => t.name);
			expect(toolNames).toContain("getRelevantQuestions");
			expect(toolNames).toContain("getAnswer");
		});
	});

	describe("Date range resolution", () => {
		// Registry:
		//   ["beta"] → Spotter3 tools (no date, only reachable via "beta")
		//   ["latest", "2026-05-01"] → newest stable entry
		//   ["backwards-compatibility-default", "2025-01-01"] → base MCP tools
		it.each([
			// Before all dated versions → falls back to oldest (2025-01-01)
			{
				apiVersion: "2020-01-01",
				expectedVersionDate: "2025-01-01",
				label: "well before all versions",
			},
			{
				apiVersion: "2024-12-31",
				expectedVersionDate: "2025-01-01",
				label: "day before earliest version",
			},
			// On or after 2025-01-01 but before 2026-05-01 → resolves to 2025-01-01
			{
				apiVersion: "2025-01-01",
				expectedVersionDate: "2025-01-01",
				label: "exact match for base version",
			},
			{
				apiVersion: "2025-01-02",
				expectedVersionDate: "2025-01-01",
				label: "day after base version",
			},
			{
				apiVersion: "2025-06-15",
				expectedVersionDate: "2025-01-01",
				label: "mid-2025",
			},
			{
				apiVersion: "2025-12-31",
				expectedVersionDate: "2025-01-01",
				label: "end of 2025",
			},
			// On or after 2026-05-01 → resolves to latest stable (2026-05-01)
			{
				apiVersion: "2026-05-01",
				expectedVersionDate: "2026-05-01",
				label: "exact match for latest version",
			},
			{
				apiVersion: "2026-06-01",
				expectedVersionDate: "2026-05-01",
				label: "start of 2026",
			},
			{
				apiVersion: "2030-01-01",
				expectedVersionDate: "2026-05-01",
				label: "far future date",
			},
		])(
			"$label: apiVersion=$apiVersion → $expectedVersionDate",
			({ apiVersion, expectedVersionDate }) => {
				const result = resolveApiVersion(apiVersion);
				expect(result.version).toContain(expectedVersionDate);
			},
		);

		// Special identifiers
		it.each([
			{
				apiVersion: "beta",
				expectedIdentifier: "beta",
				label: "beta identifier",
			},
			{
				apiVersion: "backwards-compatibility-default",
				expectedIdentifier: "backwards-compatibility-default",
				label: "backwards-compatibility-default identifier",
			},
			{
				apiVersion: "latest",
				expectedIdentifier: "latest",
				label: "latest identifier",
			},
		])(
			"$label: apiVersion=$apiVersion → contains $expectedIdentifier",
			({ apiVersion, expectedIdentifier }) => {
				const result = resolveApiVersion(apiVersion);
				expect(result.version).toContain(expectedIdentifier);
			},
		);

		// Invalid versions → throw
		it.each([
			{ apiVersion: "beta2", label: "unknown identifier" },
			{ apiVersion: "invalid", label: "invalid string" },
			{ apiVersion: "2025-13-01", label: "malformed date" },
		])("$label: apiVersion=$apiVersion → throws", ({ apiVersion }) => {
			expect(() => resolveApiVersion(apiVersion)).toThrow();
		});

		// Null → throws; undefined → resolves to latest
		it("null → throws", () => {
			expect(() => resolveApiVersion(null as any)).toThrow();
		});

		it("undefined → resolves to latest", () => {
			const result = resolveApiVersion(undefined);
			expect(result.version).toContain("latest");
		});
	});
});

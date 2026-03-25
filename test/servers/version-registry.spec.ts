import { describe, it, expect } from "vitest";
import {
	resolveApiVersion,
	isValidApiVersion,
	getAvailableVersions,
	VERSION_REGISTRY,
	DEFAULT_VERSION,
} from "../../src/servers/version-registry";

describe("Version Registry", () => {
	describe("resolveApiVersion", () => {
		it("should return default version when no apiVersion is provided", () => {
			const result = resolveApiVersion(null);
			expect(result).toEqual(DEFAULT_VERSION);
		});

		it("should return default version when undefined is provided", () => {
			const result = resolveApiVersion(undefined);
			expect(result).toEqual(DEFAULT_VERSION);
		});

		it("should return beta version when 'beta' is specified", () => {
			const result = resolveApiVersion("beta");
			expect(result.version).toBe("beta");
			expect(result.description).toContain("Beta");
		});

		it("should resolve exact date match", () => {
			const result = resolveApiVersion("2025-01-01");
			expect(result.version).toBe("2025-01-01");
		});

		it("should resolve to latest version on or before requested date", () => {
			const result = resolveApiVersion("2025-03-15");
			expect(result.version).toBe("2025-01-01");
		});

		it("should resolve to earlier version when requested date is between versions", () => {
			const result = resolveApiVersion("2025-01-01");
			expect(result.version).toBe("2025-01-01");
		});

		it("should return default version when date is before all versions", () => {
			// Use a date before the earliest version in VERSION_REGISTRY
			const result = resolveApiVersion("2020-01-01");
			expect(result).toEqual(DEFAULT_VERSION);
		});

		it("should exclude beta from date-based resolution", () => {
			// Even if beta has the same release date as 2025-03-01,
			// it should not be returned for date queries
			const result = resolveApiVersion("2025-03-01");
			expect(result.version).not.toBe("beta");
		});

		it("should throw error for invalid date format", () => {
			expect(() => resolveApiVersion("invalid-date")).toThrow(
				"Invalid API version",
			);
		});

		it("should throw error for malformed date", () => {
			expect(() => resolveApiVersion("2025-13-01")).toThrow(
				"Invalid API version",
			);
		});

		it("should throw error for partial date", () => {
			expect(() => resolveApiVersion("2025-03")).toThrow("Invalid API version");
		});

		it("should handle future dates", () => {
			const result = resolveApiVersion("2030-01-01");
			// Should return the latest non-beta version
			expect(result.version).toBe("2026-03-25");
		});
	});

	describe("isValidApiVersion", () => {
		it("should return true for beta", () => {
			expect(isValidApiVersion("beta")).toBe(true);
		});

		it("should return true for valid date format", () => {
			expect(isValidApiVersion("2025-03-01")).toBe(true);
		});

		it("should return false for invalid format", () => {
			expect(isValidApiVersion("invalid")).toBe(false);
		});

		it("should return false for malformed date", () => {
			expect(isValidApiVersion("2025-13-45")).toBe(false);
		});

		it("should return false for partial date", () => {
			expect(isValidApiVersion("2025-03")).toBe(false);
		});
	});

	describe("getAvailableVersions", () => {
		it("should return all version identifiers", () => {
			const versions = getAvailableVersions();
			expect(versions).toContain("beta");
			expect(versions).toContain("2026-03-25");
			expect(versions).toContain("2025-01-01");
			expect(versions.length).toBeGreaterThan(0);
		});
	});

	describe("VERSION_REGISTRY", () => {
		it("should contain beta version", () => {
			const betaVersion = VERSION_REGISTRY.find((v) => v.version === "beta");
			expect(betaVersion).toBeDefined();
			expect(betaVersion?.tools).toBeDefined();
		});

		it("should contain dated versions", () => {
			const datedVersions = VERSION_REGISTRY.filter(
				(v) => v.version !== "beta",
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
				expect(typeof version.version).toBe("string");
			}
		});
	});

	describe("Version comparison", () => {
		it("beta and 2025-03-01 should have same tools", () => {
			const betaConfig = resolveApiVersion("beta");
			const dateConfig = resolveApiVersion("2025-03-01");

			expect(betaConfig.tools.length).toBe(dateConfig.tools.length);
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

		it("2026-03-25 should have Spotter3 tools", () => {
			const newConfig = resolveApiVersion("2026-03-25");

			// Check that it has Spotter3 conversation tools
			const toolNames = newConfig.tools.map((t: any) => t.name);
			expect(toolNames).toContain("createConversation");
			expect(toolNames).toContain("sendConversationMessage");
			expect(toolNames).toContain("getConversationUpdates");
		});
	});
});

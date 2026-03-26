import {
	toolDefinitionsMCPServer,
	toolDefinitionsMCPServerSpotter3,
} from "./tool-definitions";

/**
 * Version configuration interface
 */
export interface VersionConfig {
	/** Version identifiers (e.g., ["2026-03-25"] or ["beta", "2026-03-25"]) */
	version: string[];
	/** Tools available in this version */
	tools: any[];
	/** Description of this version */
	description: string;
}

/**
 * Parses the release date from a version's date identifiers
 * @param versions - The version identifiers array (e.g., ["beta", "2026-03-25"])
 * @returns The parsed date from the first valid YYYY-MM-DD string in the array, or null if none found
 */
function getReleaseDateFromVersion(versions: string[]): Date | null {
	const dateVersion = versions.find((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
	if (dateVersion) {
		return new Date(dateVersion);
	}
	return null;
}

/**
 * Version registry mapping version identifiers to their configurations
 *
 * IMPORTANT: Versions MUST be ordered by release date (newest first).
 * When adding new versions, ensure they are inserted in the correct position
 * to maintain this ordering, as the resolution logic depends on it.
 * There should always be a "default" stable version that serves as the fallback for
 * any requests without a specified version or with a date before all versions.
 */
export const VERSION_REGISTRY: VersionConfig[] = [
	{
		version: ["beta"],
		tools: [...toolDefinitionsMCPServerSpotter3],
		description: "Spotter3 agent conversation tools released",
	},
	{
		version: ["default", "2025-01-01"],
		tools: [...toolDefinitionsMCPServer],
		description: "Base version with getRelevantQuestions and getAnswer tools",
	},
];

function getDefaultVersionConfig() {
	const defaultVersion = VERSION_REGISTRY.find((v) =>
		v.version.includes("default"),
	);
	if (defaultVersion) {
		return defaultVersion;
	}
	if (VERSION_REGISTRY.length > 0) {
		return VERSION_REGISTRY[0];
	}
	throw new Error("No available API versions in registry.");
}

/**
 * Resolves an API version string to a version configuration
 * @param apiVersion - The API version string (e.g., "beta", "2025-03-01", or null for default)
 * @returns The resolved version configuration
 */
export function resolveApiVersion(
	apiVersion: string | null | undefined,
): VersionConfig {
	// No version specified - return the entry marked as "default"
	if (!apiVersion) {
		return getDefaultVersionConfig();
	}

	// Check for exact match (including "beta")
	const exactMatch = VERSION_REGISTRY.find((v) =>
		v.version.includes(apiVersion),
	);
	if (exactMatch) {
		return exactMatch;
	}

	// Try to parse as date (YYYY-MM-DD format)
	const dateMatch = apiVersion.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!dateMatch) {
		return getDefaultVersionConfig();
	}

	const requestedDate = new Date(apiVersion);

	// Validate the date is valid
	if (Number.isNaN(requestedDate.getTime())) {
		return getDefaultVersionConfig();
	}

	// Find the latest version released on or before the requested date
	// Entries without a date identifier are excluded from date-based resolution
	// Note: No sort needed as VERSION_REGISTRY is already ordered by release date (newest first)
	const matchingVersion = VERSION_REGISTRY.filter((v) => {
		const releaseDate = getReleaseDateFromVersion(v.version);
		return releaseDate !== null && releaseDate <= requestedDate;
	})[0];

	if (matchingVersion) {
		return matchingVersion;
	}

	// If no version found on or before the date, return the default entry
	return getDefaultVersionConfig();
}

import {
	toolDefinitionsMCPServer,
	toolDefinitionsMCPServerSpotter3,
} from "./tool-definitions";

/**
 * Version configuration interface
 */
export interface VersionConfig {
	/** Version identifier (e.g., "beta", "2024-03-15") */
	version: string;
	/** Tools available in this version */
	tools: any[];
	/** Description of this version */
	description: string;
}

/**
 * Parses the release date from a version string
 * @param version - The version string (e.g., "2025-01-01", "beta")
 * @returns The parsed date, or a default date for "beta"
 */
function getReleaseDateFromVersion(version: string): Date {
	if (version === "beta") {
		return new Date("2026-03-25");
	}
	return new Date(version);
}

/**
 * Version registry mapping version identifiers to their configurations
 *
 * IMPORTANT: Versions MUST be ordered by release date (newest first).
 * When adding new versions, ensure they are inserted in the correct position
 * to maintain this ordering, as the resolution logic depends on it.
 */
export const VERSION_REGISTRY: VersionConfig[] = [
	{
		version: "beta",
		tools: [...toolDefinitionsMCPServerSpotter3],
		description: "Beta version with Spotter3 agent conversation tools",
	},
	{
		version: "2026-03-25",
		tools: [...toolDefinitionsMCPServerSpotter3],
		description: "Spotter3 agent conversation tools released",
	},
	{
		version: "2025-01-01",
		tools: [...toolDefinitionsMCPServer],
		description: "Base version with getRelevantQuestions and getAnswer tools",
	},
];

/**
 * Default version configuration (latest stable, not beta)
 */
export const DEFAULT_VERSION: VersionConfig = {
	version: "default",
	tools: [...toolDefinitionsMCPServer],
	description: "Default stable version",
};

/**
 * Resolves an API version string to a version configuration
 * @param apiVersion - The API version string (e.g., "beta", "2025-03-01", or null for default)
 * @returns The resolved version configuration
 */
export function resolveApiVersion(
	apiVersion: string | null | undefined,
): VersionConfig {
	// No version specified - return default
	if (!apiVersion) {
		return DEFAULT_VERSION;
	}

	// Check for exact match (including "beta")
	const exactMatch = VERSION_REGISTRY.find((v) => v.version === apiVersion);
	if (exactMatch) {
		return exactMatch;
	}

	// Try to parse as date (YYYY-MM-DD format)
	const dateMatch = apiVersion.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!dateMatch) {
		// Invalid version format - handle error case first
		throw new Error(
			`Invalid API version: ${apiVersion}. Expected "beta" or "YYYY-MM-DD" format.`,
		);
	}

	const requestedDate = new Date(apiVersion);

	// Validate the date is valid
	if (Number.isNaN(requestedDate.getTime())) {
		throw new Error(
			`Invalid API version: ${apiVersion}. Expected "beta" or "YYYY-MM-DD" format.`,
		);
	}

	// Find the latest version released on or before the requested date
	// Exclude beta versions from date-based resolution
	// Note: No sort needed as VERSION_REGISTRY is already ordered by release date (newest first)
	const matchingVersion = VERSION_REGISTRY.filter(
		(v) => v.version !== "beta",
	).filter((v) => getReleaseDateFromVersion(v.version) <= requestedDate)[0];

	if (matchingVersion) {
		return matchingVersion;
	}

	// If no version found on or before the date, return default
	return DEFAULT_VERSION;
}

/**
 * Validates if a given API version string is valid
 * @param apiVersion - The API version string to validate
 * @returns true if valid, false otherwise
 */
export function isValidApiVersion(apiVersion: string): boolean {
	try {
		resolveApiVersion(apiVersion);
		return true;
	} catch {
		return false;
	}
}

/**
 * Gets all available version identifiers
 * @returns Array of version strings
 */
export function getAvailableVersions(): string[] {
	return VERSION_REGISTRY.map((v) => v.version);
}

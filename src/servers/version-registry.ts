import { toolDefinitionsV1, toolDefinitionsV2 } from "./tool-definitions";

const YYYY_MM_DD_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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
 * Given a list of version names, returns a date if there is a valid date-based version identifier.
 * This should always be the last entry in the list if present.
 */
function getReleaseDateFromVersion(versions: string[]): Date | null {
	const possibleDateVersion = versions[versions.length - 1];
	const isDate = YYYY_MM_DD_DATE_REGEX.test(possibleDateVersion);
	if (!isDate) {
		return null;
	}
	return new Date(possibleDateVersion);
}

/**
 * Version registry, with respective tools to expose by API version. The "version" field can
 * contain multiple identifiers for the same version. Important ordering rules:
 * - Entries in the registry must be in chronological order, with newest first
 * - Entries in the "version" field must include the plain date (if present) as the last entry
 */
export const VERSION_REGISTRY: VersionConfig[] = [
	{
		version: ["beta"],
		tools: [...toolDefinitionsV2],
		description: "Spotter3 agent conversation tools released",
	},
	{
		version: ["latest", "2026-05-01"],
		tools: [...toolDefinitionsV2],
		description: "Spotter3 agent conversation tools released",
	},
	{
		version: ["backwards-compatibility-default", "2025-01-01"],
		tools: [...toolDefinitionsV1],
		description: "Base version with getRelevantQuestions and getAnswer tools",
	},
];

/**
 * Resolves an API version string to a version configuration, defaulting to latest
 */
export function resolveApiVersion(apiVersion = "latest"): VersionConfig {
	// Check for exact match (including non-dates like "beta", "latest", etc)
	const exactMatch = VERSION_REGISTRY.find((v) =>
		v.version.includes(apiVersion),
	);
	if (exactMatch) {
		return exactMatch;
	}

	// Try to parse as date
	const isDate = YYYY_MM_DD_DATE_REGEX.test(apiVersion);
	if (!isDate) {
		throw new Error(
			`Invalid date format in API version, expected YYYY-MM-DD: ${apiVersion}`,
		);
	}

	const requestedDate = new Date(apiVersion);
	if (Number.isNaN(requestedDate.getTime())) {
		throw new Error(
			`Invalid date format in API version, expected YYYY-MM-DD: ${apiVersion}`,
		);
	}

	// Find the newest version on or before the requested date. Note that the version registry is
	// already ordered from newest to oldest. We ignore any entries without a date-based version.
	const matchingVersion = VERSION_REGISTRY.find((v) => {
		const releaseDate = getReleaseDateFromVersion(v.version);
		return releaseDate !== null && releaseDate <= requestedDate;
	});
	if (matchingVersion) {
		return matchingVersion;
	}

	// If requesting an API version older than the oldest available version, return the oldest
	// available version
	console.warn(
		"Requested API version is older than all available versions, defaulting to oldest available version",
		apiVersion,
	);
	return VERSION_REGISTRY[VERSION_REGISTRY.length - 1];
}

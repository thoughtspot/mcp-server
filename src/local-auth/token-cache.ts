// On-disk cache for the stdio browser sign-in token, so a token minted once is
// reused across process spawns instead of re-prompting on every launch. Node-only
// (fs/os); the Worker never touches this.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CachedCredentials {
	instanceUrl: string;
	accessToken: string;
}

const CACHE_DIR = join(homedir(), ".thoughtspot-mcp");
const CACHE_FILE = join(CACHE_DIR, "credentials.json");

// Returns the cached credentials, or null if absent/unreadable/malformed.
export function loadCachedCredentials(): CachedCredentials | null {
	try {
		const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
		const { instanceUrl, accessToken } = parsed ?? {};
		if (typeof instanceUrl === "string" && typeof accessToken === "string") {
			return { instanceUrl, accessToken };
		}
	} catch {
		// Missing or corrupt cache: treat as no credentials.
	}
	return null;
}

// Best-effort persist with owner-only permissions; logs and swallows failures.
export function saveCachedCredentials(creds: CachedCredentials): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
		writeFileSync(CACHE_FILE, JSON.stringify(creds), { mode: 0o600 });
		chmodSync(CACHE_FILE, 0o600); // enforce even if the file pre-existed
	} catch (e) {
		console.error(
			`[ThoughtSpot MCP] Could not cache credentials: ${(e as Error).message}`,
		);
	}
}

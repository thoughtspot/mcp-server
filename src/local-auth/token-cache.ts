// On-disk cache for the stdio browser sign-in token, reused across process
// spawns. Node-only (fs/os); the Worker never touches this.

import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
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
		chmodSync(CACHE_DIR, 0o700); // tighten even if the dir pre-existed
		// Write to a 0600 temp file and rename in: writeFileSync's mode is
		// ignored when the target exists, which would leave the token briefly
		// world-readable. rename is atomic and keeps the temp file's perms.
		const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(creds), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, CACHE_FILE);
	} catch (e) {
		console.error(
			`[ThoughtSpot MCP] Could not cache credentials: ${(e as Error).message}`,
		);
	}
}

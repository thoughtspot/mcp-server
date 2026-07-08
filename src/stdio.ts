#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateAndSanitizeUrl } from "@thoughtspot/mcp-auth";
import { loginViaBrowser } from "./local-auth/browser-login.js";
import {
	type CachedCredentials,
	loadCachedCredentials,
	saveCachedCredentials,
} from "./local-auth/token-cache.js";
import { MCPServer } from "./servers/mcp-server.js";
import type { Props } from "./utils.js";

// stdout carries the JSON-RPC protocol; route all logging to stderr so it
// can't corrupt it.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

// "valid": cluster resolved a session. "invalid": cluster rejected the token.
// "unreachable": network/5xx/non-JSON — a cluster problem, not the token, so
// callers must not discard the token in favour of a browser popup.
type TokenCheck = "valid" | "invalid" | "unreachable";

async function checkToken(url: string, token: string): Promise<TokenCheck> {
	let response: Response;
	try {
		response = await fetch(`${url}/prism/preauth/info`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
		});
	} catch {
		return "unreachable";
	}
	if (response.status === 401 || response.status === 403) {
		return "invalid";
	}
	if (!response.ok) {
		return "unreachable";
	}
	try {
		const data = (await response.json()) as { info?: { userGUID?: string } };
		return data?.info?.userGUID ? "valid" : "invalid";
	} catch {
		return "unreachable";
	}
}

async function main() {
	const rawInstance = process.env.TS_INSTANCE;
	const token = process.env.TS_AUTH_TOKEN;

	let defaultInstanceUrl = "";
	if (rawInstance) {
		try {
			defaultInstanceUrl = validateAndSanitizeUrl(rawInstance);
		} catch (e) {
			console.error(
				`[ThoughtSpot MCP] Ignoring invalid TS_INSTANCE: ${(e as Error).message}`,
			);
		}
	}

	// Resolve credentials: a valid env token, then a valid cached token, then a
	// browser sign-in (whose result we cache). A token that fails only because
	// the cluster is unreachable is never discarded for a browser popup — the
	// popup can't fix a down cluster and would hang headless hosts.
	let resolved: CachedCredentials | undefined;
	let sawUnreachable = false;

	if (defaultInstanceUrl && token) {
		const check = await checkToken(defaultInstanceUrl, token);
		if (check === "valid") {
			resolved = { instanceUrl: defaultInstanceUrl, accessToken: token };
		} else if (check === "unreachable") {
			sawUnreachable = true;
		}
	}

	const cached = resolved ? null : loadCachedCredentials();
	if (!resolved && cached) {
		const check = await checkToken(cached.instanceUrl, cached.accessToken);
		if (check === "valid") {
			resolved = cached;
		} else if (check === "unreachable") {
			sawUnreachable = true;
		}
	}

	if (!resolved) {
		// We had a token but couldn't reach the cluster: fail fast instead of
		// opening a browser that can't help.
		if ((token || cached) && sawUnreachable) {
			throw new Error(
				"Could not reach the ThoughtSpot cluster to validate the existing token. Check connectivity / TS_INSTANCE and retry.",
			);
		}
		if (token) {
			console.error(
				"[ThoughtSpot MCP] TS_AUTH_TOKEN is missing or expired — opening browser sign-in.",
			);
		}
		resolved = await loginViaBrowser(defaultInstanceUrl);
		saveCachedCredentials(resolved);
	}

	const { instanceUrl, accessToken } = resolved;

	const props: Props = {
		instanceUrl,
		accessToken,
		clientName: {
			clientId: "stdio-client",
			clientName: "StdIO Client",
			registrationDate: Date.now(),
		},
	};

	const server = new MCPServer({ props });
	await server.init();

	const transport = new StdioServerTransport();
	await server.connect(transport);

	// Handle shutdown signals
	process.on("SIGINT", () => {
		console.error("[ThoughtSpot MCP] Received SIGINT signal. Shutting down...");
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		console.error(
			"[ThoughtSpot MCP] Received SIGTERM signal. Shutting down...",
		);
		process.exit(0);
	});

	console.log(
		"[ThoughtSpot MCP] Server is now handling requests. Press Ctrl+C to terminate.",
	);
}

main().catch((error) => {
	console.error("[ThoughtSpot MCP] Error:", error);
	process.exit(1);
});

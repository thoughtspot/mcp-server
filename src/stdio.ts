#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateAndSanitizeUrl } from "@thoughtspot/mcp-auth";
import { loginViaBrowser } from "./local-auth/browser-login.js";
import {
	loadCachedCredentials,
	saveCachedCredentials,
} from "./local-auth/token-cache.js";
import { MCPServer } from "./servers/mcp-server.js";
import { getThoughtSpotClient } from "./thoughtspot/thoughtspot-client.js";
import type { Props } from "./utils.js";

// stdout carries the JSON-RPC protocol; route all logging to stderr so it
// can't corrupt it.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

// True only if the cluster accepts the token.
async function isTokenValid(url: string, token: string): Promise<boolean> {
	try {
		const info = await (
			getThoughtSpotClient(url, token) as unknown as {
				getSessionInfo: () => Promise<{ userGUID?: string } | undefined>;
			}
		).getSessionInfo();
		return Boolean(info?.userGUID);
	} catch {
		return false;
	}
}

async function main() {
	let instanceUrl: string;
	let accessToken: string;

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

	// Try auth in order: valid env token, then valid cached token, then a
	// browser sign-in (whose result we cache).
	if (
		defaultInstanceUrl &&
		token &&
		(await isTokenValid(defaultInstanceUrl, token))
	) {
		instanceUrl = defaultInstanceUrl;
		accessToken = token;
	} else {
		const cached = loadCachedCredentials();
		if (
			cached &&
			(await isTokenValid(cached.instanceUrl, cached.accessToken))
		) {
			({ instanceUrl, accessToken } = cached);
		} else {
			if (token) {
				console.error(
					"[ThoughtSpot MCP] TS_AUTH_TOKEN is missing or expired — opening browser sign-in.",
				);
			}
			({ instanceUrl, accessToken } =
				await loginViaBrowser(defaultInstanceUrl));
			saveCachedCredentials({ instanceUrl, accessToken });
		}
	}

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

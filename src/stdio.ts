#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loginWithSSO } from "./local-auth/sso-login.js";
import { validateAndSanitizeUrl } from "./oauth-manager/oauth-utils.js";
import { MCPServer } from "./servers/mcp-server.js";
import type { Props } from "./utils.js";

// The stdio MCP transport reserves stdout exclusively for JSON-RPC framing.
// console.log/info/debug write to stdout in Node, which corrupts the protocol
// (the client tries to JSON.parse the log lines). Route all of them to stderr.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

async function main() {
	// TS_INSTANCE is optional now: it only prefills the cluster field on the
	// login page. The user picks (or confirms) the cluster in the browser, so
	// any cluster can be targeted from a single launch. Because it is merely a
	// prefill, an invalid value is ignored rather than aborting startup.
	let defaultInstanceUrl = "";
	if (process.env.TS_INSTANCE) {
		try {
			defaultInstanceUrl = validateAndSanitizeUrl(process.env.TS_INSTANCE);
		} catch (e) {
			console.error(
				`[ThoughtSpot MCP] Ignoring invalid TS_INSTANCE: ${(e as Error).message}`,
			);
		}
	}

	// Authentication is always interactive SSO: open the browser, let the user
	// choose a cluster and sign in, and capture the resulting bearer token.
	const { instanceUrl, accessToken } = await loginWithSSO(defaultInstanceUrl);

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

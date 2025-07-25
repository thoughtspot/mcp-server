#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCPServer } from "./servers/mcp-server.js";
import type { Props } from "./utils.js";
import { validateAndSanitizeUrl } from "./oauth-manager/oauth-utils.js";

async function main() {
    const instanceUrl = process.env.TS_INSTANCE;
    const accessToken = process.env.TS_AUTH_TOKEN;

    if (!instanceUrl || !accessToken) {
        console.error("Error: TS_INSTANCE and TS_AUTH_TOKEN environment variables must be set");
        process.exit(1);
    }

    const props: Props = {
        instanceUrl: validateAndSanitizeUrl(instanceUrl),
        accessToken,
        clientName: {
            clientId: "stdio-client",
            clientName: "Stdio Client",
            registrationDate: Date.now()
        }
    };

    const server = new MCPServer({ props, env: undefined });
    await server.init();

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Handle shutdown signals
    process.on('SIGINT', () => {
        console.error('[ThoughtSpot MCP] Received SIGINT signal. Shutting down...');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.error('[ThoughtSpot MCP] Received SIGTERM signal. Shutting down...');
        process.exit(0);
    });

    console.log(
        '[ThoughtSpot MCP] Server is now handling requests. Press Ctrl+C to terminate.',
    );
}

main().catch((error) => {
    console.error("[ThoughtSpot MCP] Error:", error);
    process.exit(1);
});

import { describe, it, expect } from "vitest";
import { connect, close } from "mcp-testing-kit";
import { MCPServer } from "../src/servers/mcp-server";

describe("MCP Server", () => {
    it("should be able to send a message to the server", async () => {
        const server = new MCPServer({
            props: {} as any,
        });
        server.init();

        const { callTool } = connect(server);

        const message = await callTool("ping", {});
        expect(message).toMatchObject({
            isError: true,
        });
    });
});
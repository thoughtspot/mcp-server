import { describe, it, expect, vi } from "vitest";
import { connect, close } from "mcp-testing-kit";
import { MCPServer } from "../src/servers/mcp-server";
import * as thoughtspotService from "../src/thoughtspot/thoughtspot-service";

describe("MCP Server", () => {
    it("should be able to send a message to the server", async () => {
        // Mock getSessionInfo to return empty object
        vi.spyOn(thoughtspotService, "getSessionInfo").mockResolvedValue({
            clusterId: "123",
            clusterName: "test",
            releaseVersion: "1.0.0",
            userGUID: "123",
            mixpanelToken: "123",
        } as any);

        const server = new MCPServer({
            props: {} as any,
        });
        await server.init();

        const { callTool } = connect(server);

        const message = await callTool("ping", {});
        expect(message).toMatchObject({
            isError: true,
        });
    });
});
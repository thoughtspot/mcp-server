import {
    env,
    runInDurableObject,
    createExecutionContext,
    waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
// Import your worker so you can unit test it
import worker, { ThoughtSpotMCP } from "../src";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("The ThoughtSpot MCP Worker: Auth handler", () => {
    it("responds with Hello World! on '/'", async () => {
        const id = env.MCP_OBJECT.idFromName("test");
        const object = env.MCP_OBJECT.get(id);
        const result = await runInDurableObject(object, async (instance) => {
            expect(instance).toBeInstanceOf(ThoughtSpotMCP);
            const request = new IncomingRequest("https://example.com/");
            // Create an empty context to pass to `worker.fetch()`
            const ctx = createExecutionContext();
            return worker.fetch(request, env, ctx);
        });
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({
            message: "Hello, World!",
        });
    });
});

describe("The ThoughtSpot MCP Worker: Tools", () => {
    it("responds with Error when Ping called without auth token", async () => {
        const id = env.MCP_OBJECT.idFromName("test");
        const object = env.MCP_OBJECT.get(id);
        try {
            const result = await runInDurableObject(object, async (instance: ThoughtSpotMCP) => {
                expect(instance).toBeInstanceOf(ThoughtSpotMCP);
                const request = new IncomingRequest("https://example.com/mcp", {
                    method: "POST",
                    body: JSON.stringify({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {
                            "name": "ping",
                        }
                    }),
                });
                // Create an empty context to pass to `worker.fetch()`
                const ctx = createExecutionContext();
                return ThoughtSpotMCP.serve("/mcp").fetch(request, env, ctx);
            });
            expect(result.status).toBe(200);
            expect(await result.json()).toMatchObject({
                message: "Hello, World!",
            });
        } finally {
            object[Symbol.dispose]!();
        }
    });
});
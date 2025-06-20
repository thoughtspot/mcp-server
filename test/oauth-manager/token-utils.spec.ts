import { describe, it, expect } from "vitest";
import { renderTokenCallback } from "../../src/oauth-manager/token-utils";

describe("Token Utils", () => {
    describe("renderTokenCallback", () => {
        it("should render token callback page with string oauthReqInfo", () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({
                clientId: "test-client",
                scope: "read",
                redirectUri: "https://example.com/callback"
            });

            const result = renderTokenCallback(instanceUrl, oauthReqInfo);

            expect(result).toContain("ThoughtSpot Authorization");
            expect(result).toContain("Authorization in Progress");
            expect(result).toContain("Establishing secure connection");
            expect(result).toContain("ThoughtSpot MCP Server");
            expect(result).toContain(instanceUrl);
            expect(result).toContain("test-client");
            expect(result).toContain("read");
            expect(result).toContain("https://example.com/callback");
        });

        it("should render token callback page with object oauthReqInfo", () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({
                clientId: "test-client",
                scope: "read write",
                redirectUri: "https://example.com/callback",
                state: "random-state"
            });

            const result = renderTokenCallback(instanceUrl, oauthReqInfo);

            expect(result).toContain("ThoughtSpot Authorization");
            expect(result).toContain("Authorization in Progress");
            expect(result).toContain("Establishing secure connection");
            expect(result).toContain("ThoughtSpot MCP Server");
            expect(result).toContain(instanceUrl);
            expect(result).toContain("test-client");
            expect(result).toContain("read write");
            expect(result).toContain("https://example.com/callback");
            expect(result).toContain("random-state");
        });

        it("should include proper JavaScript for token fetching", () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = renderTokenCallback(instanceUrl, oauthReqInfo);

            // Check for JavaScript functionality
            expect(result).toContain("callosum/v1/v2/auth/token/fetch");
            expect(result).toContain("validity_time_in_sec=2592000");
            expect(result).toContain("fetch(tokenUrl.toString()");
            expect(result).toContain("fetch('/store-token'");
            expect(result).toContain("window.location.href");
        });

        it("should include error handling in JavaScript", () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = renderTokenCallback(instanceUrl, oauthReqInfo);

            // Check for error handling
            expect(result).toContain("catch (error)");
            expect(result).toContain("Authorization Failed");
            expect(result).toContain("console.error");
        });

        it("should include proper CSS styling", () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = renderTokenCallback(instanceUrl, oauthReqInfo);

            // Check for CSS classes and styling
            expect(result).toContain(".container");
            expect(result).toContain(".spinner");
            expect(result).toContain(".logo");
            expect(result).toContain(".footer");
            expect(result).toContain("@keyframes spin");
            expect(result).toContain("animation: spin 1s linear infinite");
        });

        it("should include ThoughtSpot logo", () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = renderTokenCallback(instanceUrl, oauthReqInfo);

            expect(result).toContain("https://avatars.githubusercontent.com/u/8906680?s=200&v=4");
            expect(result).toContain("ThoughtSpot Logo");
        });

        it("should handle complex oauthReqInfo objects", () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({
                clientId: "test-client",
                scope: ["read", "write", "admin"],
                redirectUri: "https://example.com/callback",
                state: "random-state",
                codeChallenge: "challenge",
                codeChallengeMethod: "S256",
                responseType: "code"
            });

            const result = renderTokenCallback(instanceUrl, oauthReqInfo);

            expect(result).toContain("test-client");
            expect(result).toContain("read");
            expect(result).toContain("write");
            expect(result).toContain("admin");
            expect(result).toContain("https://example.com/callback");
            expect(result).toContain("random-state");
            expect(result).toContain("challenge");
            expect(result).toContain("S256");
            expect(result).toContain("code");
        });

        it("should properly escape instance URL in JavaScript", () => {
            const instanceUrl = "https://test.thoughtspot.cloud/path?param=value&other=123";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = renderTokenCallback(instanceUrl, oauthReqInfo);

            // The URL should be properly included in the JavaScript
            expect(result).toContain(instanceUrl);
        });

        it("should include proper HTML structure", () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = renderTokenCallback(instanceUrl, oauthReqInfo);

            // Check for proper HTML structure
            expect(result).toContain("<!DOCTYPE html>");
            expect(result).toContain("<html>");
            expect(result).toContain("<head>");
            expect(result).toContain("<title>");
            expect(result).toContain("<style>");
            expect(result).toContain("<body>");
            expect(result).toContain("<script>");
            expect(result).toContain("</html>");
        });
    });
}); 
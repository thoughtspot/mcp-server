import { describe, it, expect, vi } from "vitest";
import { 
    renderApprovalDialog, 
    parseRedirectApproval, 
    validateAndSanitizeUrl,
    type ApprovalDialogOptions,
    buildSamlRedirectUrl
} from "../../src/oauth-manager/oauth-utils";
import { decodeBase64Url } from 'hono/utils/encode';

describe("OAuth Utils", () => {
    describe("renderApprovalDialog", () => {
        it("should render approval dialog with basic options", () => {
            const request = new Request("https://example.com/authorize");
            const options: ApprovalDialogOptions = {
                client: {
                    clientId: "test-client",
                    clientName: "Test Client",
                    registrationDate: Date.now(),
                    redirectUris: ["https://example.com/callback"],
                    tokenEndpointAuthMethod: "client_secret_basic"
                },
                server: {
                    name: "Test Server",
                    description: "Test Description"
                },
                state: { test: "data" }
            };

            const response = renderApprovalDialog(request, options);
            
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toContain("text/html");
            
            return response.text().then(html => {
                expect(html).toContain("Test Server");
                expect(html).toContain("ThoughtSpot MCP Server wants access");
                expect(html).toContain("Authorization Request");
            });
        });

        it("should render approval dialog with custom server logo", () => {
            const request = new Request("https://example.com/authorize");
            const options: ApprovalDialogOptions = {
                client: {
                    clientId: "test-client",
                    clientName: "Test Client",
                    registrationDate: Date.now(),
                    redirectUris: ["https://example.com/callback"],
                    tokenEndpointAuthMethod: "client_secret_basic"
                },
                server: {
                    name: "Test Server",
                    logo: "https://example.com/logo.png"
                },
                state: { test: "data" }
            };

            const response = renderApprovalDialog(request, options);
            
            return response.text().then(html => {
                // The actual implementation uses hardcoded logos, not the server.logo
                expect(html).toContain("https://avatars.githubusercontent.com/u/8906680?s=200&v=4");
            });
        });

        it("should handle null client gracefully", () => {
            const request = new Request("https://example.com/authorize");
            const options: ApprovalDialogOptions = {
                client: null,
                server: {
                    name: "Test Server"
                },
                state: { test: "data" }
            };

            const response = renderApprovalDialog(request, options);
            
            expect(response.status).toBe(200);
            return response.text().then(html => {
                expect(html).toContain("ThoughtSpot MCP Server wants access");
            });
        });

        it("should sanitize HTML in server name", () => {
            const request = new Request("https://example.com/authorize");
            const options: ApprovalDialogOptions = {
                client: {
                    clientId: "test-client",
                    clientName: "Test Client",
                    registrationDate: Date.now(),
                    redirectUris: ["https://example.com/callback"],
                    tokenEndpointAuthMethod: "client_secret_basic"
                },
                server: {
                    name: "<script>alert('xss')</script>Test Server"
                },
                state: { test: "data" }
            };

            const response = renderApprovalDialog(request, options);
            
            return response.text().then(html => {
                expect(html).toContain("Test Server");
                expect(html).toContain("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;Test Server");
                expect(html).not.toContain("<script>alert('xss')</script>");
            });
        });
    });

    describe("validateAndSanitizeUrl", () => {
        it("should validate and return valid URLs", () => {
            const validUrls = [
                "https://example.com",
                "https://test.thoughtspot.cloud",
                "https://subdomain.example.com",
                "https://example.com:8080"
            ];

            for (const url of validUrls) {
                expect(() => validateAndSanitizeUrl(url)).not.toThrow();
                expect(validateAndSanitizeUrl(url)).toBe(url);
            }
        });

        it("should add https:// to URLs without protocol", () => {
            expect(validateAndSanitizeUrl("example.com")).toBe("https://example.com");
            expect(validateAndSanitizeUrl("test.thoughtspot.cloud")).toBe("https://test.thoughtspot.cloud");
        });

        it("should normalize URLs by removing paths and query params", () => {
            expect(validateAndSanitizeUrl("https://example.com/path")).toBe("https://example.com");
            expect(validateAndSanitizeUrl("https://example.com:8080/path?param=value")).toBe("https://example.com:8080");
        });

        it("should throw error for invalid URLs", () => {
            const invalidUrls = [
                "http://", // Missing hostname
                "https://", // Missing hostname
                "://example.com", // Missing protocol
            ];

            for (const url of invalidUrls) {
                expect(() => validateAndSanitizeUrl(url)).toThrow();
            }
        });

        it("should throw error for empty URL", () => {
            expect(() => validateAndSanitizeUrl("")).toThrow();
        });
    });

    describe("parseRedirectApproval", () => {
        it("should parse valid form data", async () => {
            const formData = new FormData();
            formData.append("state", btoa(JSON.stringify({ oauthReqInfo: { clientId: "test" } })));
            formData.append("instanceUrl", "https://test.thoughtspot.cloud");

            const request = new Request("https://example.com/authorize", {
                method: "POST",
                body: formData
            });

            const result = await parseRedirectApproval(request);
            
            expect(result.state).toEqual({ oauthReqInfo: { clientId: "test" } });
            expect(result.instanceUrl).toBe("https://test.thoughtspot.cloud");
        });

        it("should throw error for missing state", async () => {
            const formData = new FormData();
            formData.append("instanceUrl", "https://test.thoughtspot.cloud");

            const request = new Request("https://example.com/authorize", {
                method: "POST",
                body: formData
            });

            await expect(parseRedirectApproval(request)).rejects.toThrow("Missing or invalid 'state' in form data");
        });

        it("should throw error for missing instance URL", async () => {
            const formData = new FormData();
            formData.append("state", btoa(JSON.stringify({ oauthReqInfo: { clientId: "test" } })));

            const request = new Request("https://example.com/authorize", {
                method: "POST",
                body: formData
            });

            await expect(parseRedirectApproval(request)).rejects.toThrow("Missing instance URL");
        });

        it("should throw error for invalid JSON in state", async () => {
            const formData = new FormData();
            formData.append("state", "invalid-base64");
            formData.append("instanceUrl", "https://test.thoughtspot.cloud");

            const request = new Request("https://example.com/authorize", {
                method: "POST",
                body: formData
            });

            await expect(parseRedirectApproval(request)).rejects.toThrow("Invalid state format");
        });

        it("should throw error for invalid instance URL", async () => {
            const formData = new FormData();
            formData.append("state", btoa(JSON.stringify({ oauthReqInfo: { clientId: "test" } })));
            formData.append("instanceUrl", "http://");

            const request = new Request("https://example.com/authorize", {
                method: "POST",
                body: formData
            });

            await expect(parseRedirectApproval(request)).rejects.toThrow("Invalid URL");
        });

        it("should handle complex state objects", async () => {
            const complexState = {
                oauthReqInfo: {
                    clientId: "test-client",
                    scope: "read write",
                    redirectUri: "https://example.com/callback",
                    state: "random-state"
                },
                additionalData: {
                    timestamp: Date.now(),
                    metadata: { source: "test" }
                }
            };

            const formData = new FormData();
            formData.append("state", btoa(JSON.stringify(complexState)));
            formData.append("instanceUrl", "https://test.thoughtspot.cloud");

            const request = new Request("https://example.com/authorize", {
                method: "POST",
                body: formData
            });

            const result = await parseRedirectApproval(request);
            
            expect(result.state).toEqual(complexState);
            expect(result.instanceUrl).toBe("https://test.thoughtspot.cloud");
        });

        it("should throw error for non-POST requests", async () => {
            const request = new Request("https://example.com/authorize", {
                method: "GET"
            });

            await expect(parseRedirectApproval(request)).rejects.toThrow("Invalid request method. Expected POST");
        });
    });

    describe("buildSamlRedirectUrl", () => {
        it("should construct a valid SAML login redirect URL", () => {
            const instanceUrl = 'https://test.thoughtspot.cloud';
            const oauthReqInfo = {
                clientId: 'test-client',
                scope: 'read',
                redirectUri: 'https://example.com/callback'
            };
            const callbackOrigin = 'https://example.com';

            const redirectUrl = buildSamlRedirectUrl(instanceUrl, oauthReqInfo, callbackOrigin);
            const url = new URL(redirectUrl);
            expect(url.origin).toBe(instanceUrl);
            expect(url.pathname).toBe('/callosum/v1/saml/login');
            const targetURLPath = url.searchParams.get('targetURLPath');
            expect(targetURLPath).toBeTruthy();
            const targetURL = new URL(targetURLPath!);
            expect(targetURL.origin).toBe(callbackOrigin);
            expect(targetURL.pathname).toBe('/callback');
            expect(targetURL.searchParams.get('instanceUrl')).toBe(instanceUrl);
            const encodedOauthReqInfo = targetURL.searchParams.get('oauthReqInfo');
            expect(encodedOauthReqInfo).toBeTruthy();
            const decodedOauthReqInfo = JSON.parse(
                new TextDecoder().decode(decodeBase64Url(encodedOauthReqInfo!))
            );
            expect(decodedOauthReqInfo).toEqual(oauthReqInfo);
        });

        it("should handle complex oauthReqInfo objects", () => {
            const instanceUrl = 'https://mycompany.thoughtspot.cloud';
            const oauthReqInfo = {
                clientId: 'test-client',
                scope: 'read write',
                redirectUri: 'https://example.com/callback',
                responseType: 'code',
                state: 'random-state',
                nonce: 'random-nonce'
            };
            const callbackOrigin = 'https://example.com';
            const redirectUrl = buildSamlRedirectUrl(instanceUrl, oauthReqInfo, callbackOrigin);
            const url = new URL(redirectUrl);
            const targetURLPath = url.searchParams.get('targetURLPath');
            const targetURL = new URL(targetURLPath!);
            const encodedOauthReqInfo = targetURL.searchParams.get('oauthReqInfo');
            const decodedOauthReqInfo = JSON.parse(
                new TextDecoder().decode(decodeBase64Url(encodedOauthReqInfo!))
            );
            expect(decodedOauthReqInfo).toEqual(oauthReqInfo);
        });

        it("should work with different callback origins", () => {
            const instanceUrl = 'https://thoughtspot.company.com';
            const oauthReqInfo = { clientId: 'abc', scope: 'openid' };
            const callbackOrigin = 'https://another.com';
            const redirectUrl = buildSamlRedirectUrl(instanceUrl, oauthReqInfo, callbackOrigin);
            const url = new URL(redirectUrl);
            const targetURLPath = url.searchParams.get('targetURLPath');
            const targetURL = new URL(targetURLPath!);
            expect(targetURL.origin).toBe(callbackOrigin);
        });

        it("should encode oauthReqInfo as base64url", () => {
            const instanceUrl = 'https://test.thoughtspot.cloud';
            const oauthReqInfo = { foo: 'bar', n: 123 };
            const callbackOrigin = 'https://example.com';
            const redirectUrl = buildSamlRedirectUrl(instanceUrl, oauthReqInfo, callbackOrigin);
            const url = new URL(redirectUrl);
            const targetURLPath = url.searchParams.get('targetURLPath');
            const targetURL = new URL(targetURLPath!);
            const encoded = targetURL.searchParams.get('oauthReqInfo');
            expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // base64url format
        });
    });
}); 
import { describe, it, expect, vi } from "vitest";
import { renderTokenCallback } from "../../src/oauth-manager/token-utils";

describe("Token Utils", () => {
    describe("renderTokenCallback", () => {
        // Mock assets that returns the static HTML content
        const mockAssets = {
            fetch: vi.fn().mockImplementation((url: string) => {
                if (url === 'https://example.com/oauth-callback.html') {
                    return Promise.resolve(new Response(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <title>ThoughtSpot Authorization</title>
                            <link rel="stylesheet" href="oauth-callback.css">
                        </head>
                        <body>
                            <div class="container">
                                <img src="https://avatars.githubusercontent.com/u/8906680?s=200&v=4" alt="ThoughtSpot Logo" class="logo">
                                <h2>Authorization in Progress</h2>
                                <div class="spinner"></div>
                                <p id="status">Establishing secure connection...</p>
                                <div class="footer">
                                    ThoughtSpot MCP Server
                                </div>
                            </div>
                            <!-- Card -->
                            <div id="manual-token-section" style="display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #f4f5f7; z-index: 9999; flex-direction: column; justify-content: center; align-items: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                                <div style="background: #fff; border-radius: 16px; box-shadow: 0 2px 12px 0 rgba(16,30,54,0.08); padding: 2.5rem 2rem 2rem 2rem; max-width: 440px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; align-items: stretch;">
                                   <div class="warning-banner">
                                    <svg class="warning-icon" width="15" height="15" viewBox="0 0 24 24" fill="none">
                                        <circle cx="12" cy="12" r="12" fill="#FFE082"/>
                                        <path d="M12 8v4m0 4h.01" stroke="#FF9800" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <circle cx="12" cy="12" r="9" stroke="#FF9800" stroke-width="2" fill="none"/>
                                    </svg>
                                    <p class="warning-text">
                                        Browser privacy settings, network issues, or strict cookie settings may be impacting authentication. <br>
                                        Take the additional steps below to fix the issue.
                                    </p>
                                    <button class="warning-close" aria-label="Dismiss">&times;</button>
                                    </div>
                                    <div style="font-size: 1.1rem; font-weight: 500; color: #23272f; margin-bottom: 1.1rem; text-align: center; letter-spacing: -0.01em;">ThoughtSpot MCP Server wants access<br>to your ThoughtSpot instance</div>
                                    <div style="font-size: 1rem; color: #23272f; font-weight: 500; margin-bottom: 0.5rem; text-align: left;">Complete the below steps to finish authenticating:</div>
                                    <ul style="text-align:left; margin: 0 0 1.2rem 1.1rem; padding: 0; color: #444; font-size: 0.9rem; line-height: 1.7; font-weight: 400;">
                                        <li>Open this <a id="manual-token-url-link" href="#" style="color:#2563eb; text-decoration:underline;">token URL</a> in a new tab</li>
                                        <li>Copy the token value or JSON</li>
                                        <li>Paste the token value or JSON into the box below</li>
                                    </ul>
                                    <label for="manual-token-input" style="margin-bottom:0.4rem; font-size: 0.8rem; color: #23272f; font-weight: 500; align-self: flex-start;">Token value or JSON</label>
                                    <textarea id="manual-token-input" rows="6" style="width:100%; max-width:100%; font-family:monospace; font-size:1rem; border: 1.2px solid #e0e3e8; border-radius: 8px; padding: 14px 14px; background: #fafbfc; margin-bottom: 1.4rem; resize: vertical; box-sizing: border-box; outline: none; transition: border 0.2s; min-height: 90px;"></textarea>
                                    <div style="display: flex; width: 100%; gap: 0.8rem; margin-top: 0.1rem;">
                                        <button id="manual-back-btn" style="flex:1; padding:12px 0; font-size:1.05rem; background: #f6f7f9; color: #23272f; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; transition: background 0.2s;">Back</button>
                                        <button id="submit-manual-token" style="flex:1; padding:12px 0; font-size:1.05rem; background: #2563eb; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; transition: background 0.2s;">Submit</button>
                                    </div>
                                </div>
                            </div>
                            <script type="application/json" id="oauth-req-info">{{OAUTH_REQ_INFO}}</script>
                            <script src="oauth-callback.js"></script>
                        </body>
                        </html>
                    `));
                } 
                if (url === 'https://example.com/oauth-callback.css') {
                    return Promise.resolve(new Response(`
                        body { background: #f8f9fa; }
                        .container { background: white; }
                        .spinner { animation: spin 1s linear infinite; }
                    `));
                }
                if (url === 'https://example.com/oauth-callback.js') {
                    return Promise.resolve(new Response(`
                        // Immediately invoke the async function
                        (async function() {
                            const oauthReqInfo = JSON.parse(document.getElementById('oauth-req-info').textContent);
                            
                            // Ensure manual section is hidden initially
                            const manualSection = document.getElementById('manual-token-section');
                            const container = document.querySelector('.container');
                            manualSection.style.display = 'none';
                            
                            try {
                                const tokenUrl = new URL('callosum/v1/v2/auth/token/fetch?validity_time_in_sec=2592000', window.INSTANCE_URL);
                                console.log('Fetching token from:', tokenUrl.toString());
                                
                                document.getElementById('status').textContent = 'Retrieving authentication token...';
                                
                                const response = await fetch(tokenUrl.toString(), {
                                    method: 'GET',
                                    credentials: 'include'
                                });
                                
                                if (!response.ok) {
                                    if (response.status === 401) {
                                        // 401 likely due to 3rd party cookies being blocked
                                        manualSection.style.display = 'flex';
                                        document.getElementById('status').textContent = '';
                                        container.style.display = 'none';
                                        
                                        // Set up event handlers after showing the section
                                        document.getElementById('manual-token-url-link').onclick = function(e) {
                                            e.preventDefault();
                                            window.open(tokenUrl.toString(), '_blank');
                                        };
                                        document.getElementById('manual-back-btn').onclick = function() {
                                            window.history.back();
                                        };
                                        document.querySelector('.warning-close').onclick = function() {
                                            document.querySelector('.warning-banner').style.display = 'none';
                                        };
                                        document.getElementById('submit-manual-token').onclick = async function() {
                                            const tokenText = document.getElementById('manual-token-input').value;
                                            let tokenData;
                                            try {
                                                // If the text starts with "data", wrap it in curly braces to make it valid JSON
                                                const jsonText = tokenText.trim().startsWith('"data"') ? '{' + tokenText + '}' : tokenText;
                                                const parsed = JSON.parse(jsonText);
                                                
                                                // Handle different token formats
                                                if (typeof parsed === 'string') {
                                                    // Case 1: tokenText is a quoted string
                                                    tokenData = { data: { token: parsed } };
                                                } else if (parsed.data && parsed.data.token) {
                                                    // Case 2: { data: { token: ... } }
                                                    tokenData = { data: { token: parsed.data.token } };
                                                } else if (parsed.token) {
                                                    // Case 3: { token: ... }
                                                    tokenData = { data: { token: parsed.token } };
                                                } else {
                                                    throw new Error('Unrecognized token format.');
                                                }
                                            } catch (e) {
                                                // If JSON parsing fails, try to extract token from the string
                                                const tokenMatch = tokenText.match(/"token"\\s*:\\s*"([^"]+)"/);
                                                if (tokenMatch) {
                                                    console.log('Token match:', tokenMatch[1]);
                                                    tokenData = { data: { token: tokenMatch[1] } };
                                                } else if (typeof tokenText === 'string' && tokenText.trim().length > 0) {
                                                    // Case 4: raw token string
                                                    console.log('Token text:', tokenText);
                                                    tokenData = { data: { token: tokenText.trim() } };
                                                } else {
                                                    document.getElementById('status').textContent = 'Invalid token format. Please paste the correct token.';
                                                    document.getElementById('status').style.color = '#dc3545';
                                                    return;
                                                }
                                            }
                                            document.getElementById('status').textContent = 'Submitting token...';
                                            document.getElementById('status').style.color = '#495057';
                                            try {
                                                const storeResponse = await fetch('/store-token', {
                                                    method: 'POST',
                                                    headers: {
                                                        'Content-Type': 'application/json'
                                                    },
                                                    body: JSON.stringify({ 
                                                        token: tokenData,
                                                        oauthReqInfo: oauthReqInfo,
                                                        instanceUrl: window.INSTANCE_URL
                                                    })
                                                });
                                                const responseData = await storeResponse.json();
                                                if (!storeResponse.ok) {
                                                    const errorText = await storeResponse.text();
                                                    throw new Error('Failed to store token (Status: ' + storeResponse.status + '): ' + errorText);
                                                }
                                                window.location.href = responseData.redirectTo;
                                            } catch (err) {
                                                document.getElementById('status').textContent = err.message;
                                                document.getElementById('status').style.color = '#dc3545';
                                            }
                                        };
                                        return;
                                    } else {
                                        const errorText = await response.text();
                                        throw new Error('Authentication failed (Status: ' + response.status + '): ' + errorText);
                                    }
                                }
                                
                                const data = await response.json();
                                document.getElementById('status').textContent = 'Authentication successful. Securing your session...';

                                // Send the token to the server
                                const storeResponse = await fetch('/store-token', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({ 
                                        token: data,
                                        oauthReqInfo: oauthReqInfo,
                                        instanceUrl: window.INSTANCE_URL
                                    })
                                });
                                const responseData = await storeResponse.json();

                                if (!storeResponse.ok) {
                                    const errorText = await storeResponse.text();
                                    throw new Error('Failed to store token (Status: ' + storeResponse.status + '): ' + errorText);
                                }

                                console.log('Redirecting to:', responseData.redirectTo);
                                window.location.href = responseData.redirectTo;
                                
                            } catch (error) {
                                console.error('Error:', error);
                                document.getElementById('status').textContent = error.message;
                                document.getElementById('status').style.color = '#dc3545';
                                document.querySelector('h2').textContent = 'Authorization Failed';
                                document.querySelector('.spinner').style.display = 'none';
                            }
                        })();
                    `));
                }
                return Promise.resolve(new Response('Not found', { status: 404 }));
            })
        };

        const testOrigin = 'https://example.com';

        it("should render token callback page with string oauthReqInfo", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({
                clientId: "test-client",
                scope: "read",
                redirectUri: "https://example.com/callback"
            });

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

            expect(result).toContain("ThoughtSpot Authorization");
            expect(result).toContain("Authorization in Progress");
            expect(result).toContain("Establishing secure connection");
            expect(result).toContain("ThoughtSpot MCP Server");
            expect(result).toContain(instanceUrl);
            expect(result).toContain("test-client");
            expect(result).toContain("read");
            expect(result).toContain("https://example.com/callback");
        });

        it("should render token callback page with object oauthReqInfo", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({
                clientId: "test-client",
                scope: "read write",
                redirectUri: "https://example.com/callback",
                state: "random-state"
            });

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

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

        it("should include instance URL in JavaScript", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

            // Check for instance URL in JavaScript
            expect(result).toContain("window.INSTANCE_URL");
            expect(result).toContain(instanceUrl);
        });

        it("should include proper CSS styling", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

            // Check for inlined CSS classes and styling
            expect(result).toContain("<style>");
            expect(result).toContain("class=\"container\"");
            expect(result).toContain("class=\"spinner\"");
            expect(result).toContain("class=\"logo\"");
            expect(result).toContain("class=\"footer\"");
        });

        it("should include ThoughtSpot logo", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

            expect(result).toContain("https://avatars.githubusercontent.com/u/8906680?s=200&v=4");
            expect(result).toContain("ThoughtSpot Logo");
        });

        it("should handle complex oauthReqInfo objects", async () => {
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

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

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

        it("should properly escape instance URL in JavaScript", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud/path?param=value&other=123";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

            // The URL should be properly included in the JavaScript
            expect(result).toContain(instanceUrl);
        });

        it("should include proper HTML structure", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

            // Check for proper HTML structure
            expect(result).toContain("<!DOCTYPE html>");
            expect(result).toContain("<html>");
            expect(result).toContain("<head>");
            expect(result).toContain("<title>");
            expect(result).toContain("<body>");
            expect(result).toContain("</html>");
        });

        it("should handle assets fetch errors gracefully", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });
            
            // Mock assets that fails to fetch
            const failingAssets = {
                fetch: vi.fn().mockRejectedValue(new Error("Failed to fetch"))
            };

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, failingAssets, testOrigin);

            // Should return fallback error page
            expect(result).toContain("Authorization Error");
            expect(result).toContain("Failed to load authorization page");
            expect(result).toContain("Failed to fetch");
        });

        it("should handle HTML file fetch failure (line 10)", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });
            
            // Mock assets that fails to fetch HTML file specifically
            const htmlFailingAssets = {
                fetch: vi.fn().mockImplementation((url: string) => {
                    if (url === 'https://example.com/oauth-callback.html') {
                        return Promise.resolve(new Response('Not found', { status: 404 }));
                    } 
                    if (url === 'https://example.com/oauth-callback.css') {
                        return Promise.resolve(new Response('body { background: #f8f9fa; }'));
                    } 
                    if (url === 'https://example.com/oauth-callback.js') {
                        return Promise.resolve(new Response('console.log("test");'));
                    }
                    return Promise.resolve(new Response('Not found', { status: 404 }));
                })
            };

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, htmlFailingAssets, testOrigin);

            // Should return fallback error page with specific error message
            expect(result).toContain("Authorization Error");
            expect(result).toContain("Failed to load authorization page");
            expect(result).toContain("Failed to load oauth-callback.html");
        });

        it("should handle CSS file fetch failure (line 17)", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });
            
            // Mock assets that fails to fetch CSS file specifically
            const cssFailingAssets = {
                fetch: vi.fn().mockImplementation((url: string) => {
                    if (url === 'https://example.com/oauth-callback.html') {
                        return Promise.resolve(new Response(`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>ThoughtSpot Authorization</title>
                                <link rel="stylesheet" href="oauth-callback.css">
                            </head>
                            <body>
                                <div class="container">
                                    <h2>Authorization in Progress</h2>
                                </div>
                                <script src="oauth-callback.js"></script>
                            </body>
                            </html>
                        `));
                    } 
                    if (url === 'https://example.com/oauth-callback.css') {
                        return Promise.resolve(new Response('Not found', { status: 404 }));
                    } 
                    if (url === 'https://example.com/oauth-callback.js') {
                        return Promise.resolve(new Response('console.log("test");'));
                    }
                    return Promise.resolve(new Response('Not found', { status: 404 }));
                })
            };

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, cssFailingAssets, testOrigin);

            // Should return fallback error page with specific error message
            expect(result).toContain("Authorization Error");
            expect(result).toContain("Failed to load authorization page");
            expect(result).toContain("Failed to load oauth-callback.css");
        });

        it("should handle JS file fetch failure (line 24)", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });
            
            // Mock assets that fails to fetch JS file specifically
            const jsFailingAssets = {
                fetch: vi.fn().mockImplementation((url: string) => {
                    if (url === 'https://example.com/oauth-callback.html') {
                        return Promise.resolve(new Response(`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>ThoughtSpot Authorization</title>
                                <link rel="stylesheet" href="oauth-callback.css">
                            </head>
                            <body>
                                <div class="container">
                                    <h2>Authorization in Progress</h2>
                                </div>
                                <script src="oauth-callback.js"></script>
                            </body>
                            </html>
                        `));
                    } 
                    if (url === 'https://example.com/oauth-callback.css') {
                        return Promise.resolve(new Response('body { background: #f8f9fa; }'));
                    } 
                    if (url === 'https://example.com/oauth-callback.js') {
                        return Promise.resolve(new Response('Not found', { status: 404 }));
                    }
                    return Promise.resolve(new Response('Not found', { status: 404 }));
                })
            };

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, jsFailingAssets, testOrigin);

            // Should return fallback error page with specific error message
            expect(result).toContain("Authorization Error");
            expect(result).toContain("Failed to load authorization page");
            expect(result).toContain("Failed to load oauth-callback.js");
        });

        it("should handle network errors during file fetch", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });
            
            // Mock assets that throws network error
            const networkErrorAssets = {
                fetch: vi.fn().mockImplementation((url: string) => {
                    if (url === 'https://example.com/oauth-callback.html') {
                        throw new Error('Network error: ECONNREFUSED');
                    }
                    return Promise.resolve(new Response('Not found', { status: 404 }));
                })
            };

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, networkErrorAssets, testOrigin);

            // Should return fallback error page with network error message
            expect(result).toContain("Authorization Error");
            expect(result).toContain("Failed to load authorization page");
            expect(result).toContain("Network error: ECONNREFUSED");
        });

        it("should handle timeout errors during file fetch", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });
            
            // Mock assets that throws timeout error
            const timeoutErrorAssets = {
                fetch: vi.fn().mockImplementation((url: string) => {
                    if (url === 'https://example.com/oauth-callback.html') {
                        throw new Error('Request timeout');
                    }
                    return Promise.resolve(new Response('Not found', { status: 404 }));
                })
            };

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, timeoutErrorAssets, testOrigin);

            // Should return fallback error page with timeout error message
            expect(result).toContain("Authorization Error");
            expect(result).toContain("Failed to load authorization page");
            expect(result).toContain("Request timeout");
        });

        it("should include JavaScript logic for token format handling", async () => {
            const instanceUrl = "https://test.thoughtspot.cloud";
            const oauthReqInfo = JSON.stringify({ clientId: "test-client" });

            const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

            // Check for token parsing logic
            expect(result).toContain("JSON.parse(jsonText)");
            expect(result).toContain("typeof parsed === 'string'");
            expect(result).toContain("parsed.data && parsed.data.token");
            expect(result).toContain("parsed.token");
            
            // Check for different token format handling
            expect(result).toContain("tokenData = { data: { token: parsed } }");
            expect(result).toContain("tokenData = { data: { token: parsed.data.token } }");
            expect(result).toContain("tokenData = { data: { token: parsed.token } }");
            
            // Check for regex token extraction
            expect(result).toContain('tokenText.match(/"token"\\s*:\\s*"([^"]+)"/)');
            
            // Check for raw token string handling
            expect(result).toContain("tokenData = { data: { token: tokenText.trim() } }");
            
            // Check for error handling
            expect(result).toContain("Invalid token format. Please paste the correct token.");
        });

        it("should handle different instance URL formats correctly", async () => {
            const testCases = [
                "https://test.thoughtspot.cloud",
                "https://mycompany.thoughtspot.cloud",
                "https://thoughtspot.company.com",
                "https://ts.company.com/path"
            ];

            for (const instanceUrl of testCases) {
                const oauthReqInfo = JSON.stringify({ clientId: "test-client" });
                const result = await renderTokenCallback(instanceUrl, oauthReqInfo, mockAssets, testOrigin);

                // Check that the instance URL is properly included in the JavaScript
                expect(result).toContain(`window.INSTANCE_URL = '${instanceUrl}'`);
                
                // Check that the token URL is constructed correctly
                expect(result).toContain("new URL('callosum/v1/v2/auth/token/fetch?validity_time_in_sec=2592000', window.INSTANCE_URL)");
            }
        });
    });
}); 
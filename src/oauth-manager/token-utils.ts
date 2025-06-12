export function renderTokenCallback(instanceUrl: string, oauthReqInfo: string) {
    // Parse the oauthReqInfo if it's a string
    const parsedOAuthReqInfo = typeof oauthReqInfo === 'string' ? JSON.parse(oauthReqInfo) : oauthReqInfo;
    const oauthReqInfoJson = JSON.stringify(parsedOAuthReqInfo);

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>ThoughtSpot Authorization</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background-color: #f8f9fa;
                color: #2c3e50;
            }
            .container {
                text-align: center;
                padding: 3rem;
                background: white;
                border-radius: 12px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                max-width: 480px;
                width: 90%;
            }
            .logo {
                width: 48px;
                height: 48px;
                margin-bottom: 1.5rem;
            }
            h2 {
                font-size: 1.5rem;
                font-weight: 600;
                margin: 0 0 1rem 0;
                color: #1a1a1a;
            }
            .spinner {
                border: 3px solid #e9ecef;
                border-top: 3px solid #0066cc;
                border-radius: 50%;
                width: 36px;
                height: 36px;
                animation: spin 1s linear infinite;
                margin: 1.5rem auto;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            #status {
                font-size: 0.95rem;
                color: #495057;
                margin: 1rem 0;
                line-height: 1.5;
            }
            .footer {
                margin-top: 2rem;
                font-size: 0.85rem;
                color: #6c757d;
            }
        </style>
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
        <div id="manual-token-section" style="display:none;">
            <div style="background: #fff; border-radius: 18px; box-shadow: 0 2px 16px 0 rgba(16,30,54,0.10), 0 1.5px 4px 0 rgba(16,30,54,0.06); padding: 2.5rem 2.2rem 2.2rem 2.2rem; max-width: 480px; margin: 2.5rem auto 0 auto; display: flex; flex-direction: column; align-items: stretch; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                <div id="manual-warning-banner" style="display:none; position: relative; background: #fff8e1; border-radius: 12px; color: #856404; font-size: 1.05rem; font-weight: 500; padding: 1.1rem 1.5rem 1.1rem 1.1rem; box-sizing: border-box; align-items: center; margin-bottom: 1.5rem; border: 1px solid #ffe082;">
                    <div style="display: flex; align-items: flex-start; gap: 0.7rem;">
                        <svg width="24" height="24" fill="none" viewBox="0 0 24 24" style="flex-shrink:0;"><circle cx="12" cy="12" r="12" fill="#ffe082"/><path d="M12 8v4m0 4h.01" stroke="#ff9800" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="#ff9800" stroke-width="2" fill="none"/></svg>
                        <span style="flex:1;">Browser privacy settings, network issues, or strict cookie settings may be impacting authentication. Take the additional steps below to fix the issue.</span>
                        <button id="manual-warning-dismiss" style="background: none; border: none; color: #856404; font-size: 1.3rem; font-weight: bold; cursor: pointer; margin-left: 0.7rem; line-height: 1;">&times;</button>
                    </div>
                </div>
                <div style="font-size: 1.22rem; font-weight: 700; color: #1a1a1a; margin-bottom: 0.7rem; text-align: center;">ThoughtSpot MCP Server wants access<br>to your ThoughtSpot instance</div>
                <div style="font-size: 1.01rem; color: #22223b; font-weight: 500; margin-bottom: 1.1rem; text-align: center;">Complete the below steps to finish authenticating:</div>
                <ul style="text-align:left; margin: 0 0 1.1rem 1.2rem; padding: 0; color: #444; font-size: 0.98rem;">
                    <li>Open this <a id="manual-token-url-link" href="#" style="color:#2563eb; text-decoration:underline;">token URL</a> in a new tab</li>
                    <li>Copy the token value or JSON</li>
                    <li>Paste the token value or JSON into the box below</li>
                </ul>
                <label for="manual-token-input" style="margin-bottom:0.5rem; font-size: 0.97rem; color: #111827; font-weight: 500; align-self: flex-start;">Token value or JSON</label>
                <textarea id="manual-token-input" rows="6" style="width:100%; max-width:100%; font-family:monospace; font-size:1rem; border: 1.5px solid #d1d5db; border-radius: 10px; padding: 16px 18px; background: #fff; margin-bottom: 1.5rem; resize: vertical; box-sizing: border-box; outline: none; transition: border 0.2s; min-height: 90px;"></textarea>
                <div style="display: flex; width: 100%; gap: 1rem; margin-top: 0.2rem;">
                    <button id="manual-back-btn" style="flex:1; padding:13px 0; font-size:1.08rem; background: #f3f4f6; color: #22223b; border: none; border-radius: 10px; cursor: pointer; font-weight: 500; transition: background 0.2s;">Back</button>
                    <button id="submit-manual-token" style="flex:1; padding:13px 0; font-size:1.08rem; background: #2563eb; color: #fff; border: none; border-radius: 10px; cursor: pointer; font-weight: 500; transition: background 0.2s;">Submit</button>
                </div>
            </div>
        </div>
        <script type="application/json" id="oauth-req-info">${oauthReqInfoJson}</script>
        <script>
            // Immediately invoke the async function
            (async function() {
                const oauthReqInfo = JSON.parse(document.getElementById('oauth-req-info').textContent);
                try {
                    const tokenUrl = new URL('callosum/v1/v2/auth/token/fetch?validity_time_in_sec=2592000', '${instanceUrl}');
                    console.log('Fetching token from:', tokenUrl.toString());
                    
                    document.getElementById('status').textContent = 'Retrieving authentication token...';
                    
                    const response = await fetch(tokenUrl.toString(), {
                        method: 'GET',
                        credentials: 'include'
                    });
                    
                    if (!response.ok) {
                        if (response.status === 401) {
                            // 401 likely due to 3rd party cookies being blocked
                            document.getElementById('manual-warning-banner').style.display = 'block';
                            document.getElementById('manual-token-section').style.display = 'block';
                            document.getElementById('status').textContent = '';
                            document.querySelector('.container').style.display = 'none';
                            document.getElementById('manual-token-url-link').onclick = function(e) {
                                e.preventDefault();
                                window.open(tokenUrl.toString(), '_blank');
                            };
                            document.getElementById('manual-back-btn').onclick = function() {
                                window.location.href = '/';
                            };
                            document.getElementById('manual-warning-dismiss').onclick = function() {
                                document.getElementById('manual-warning-banner').style.display = 'none';
                            };
                            document.getElementById('submit-manual-token').onclick = async function() {
                                const tokenText = document.getElementById('manual-token-input').value;
                                let tokenData;
                                try {
                                    const parsed = JSON.parse(tokenText);
                                    if (typeof parsed === 'string') {
                                        // Case 3: tokenText is a quoted string
                                        tokenData = { data: { token: parsed } };
                                    } else if (parsed.data && parsed.data.token) {
                                        // Case 1: { data: { token: ... } }
                                        tokenData = parsed;
                                    } else if (parsed.token) {
                                        // Case 2: { token: ... }
                                        tokenData = { data: { token: parsed.token } };
                                    } else {
                                        throw new Error('Unrecognized token format.');
                                    }
                                } catch (e) {
                                    // If not JSON, treat as raw token string (Case 3)
                                    if (typeof tokenText === 'string' && tokenText.trim().length > 0) {
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
                                            instanceUrl: '${instanceUrl}'
                                        })
                                    });
                                    const responseData = await storeResponse.json();
                                    if (!storeResponse.ok) {
                                        const errorText = await storeResponse.text();
                                        throw new Error(\`Failed to store token (Status: \${storeResponse.status}): \${errorText}\`);
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
                            throw new Error(\`Authentication failed (Status: \${response.status}): \${errorText} \`);
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
                            instanceUrl: '${instanceUrl}'
                        })
                    });
                    const responseData = await storeResponse.json();

                    if (!storeResponse.ok) {
                        const errorText = await storeResponse.text();
                        throw new Error(\`Failed to store token (Status: \${storeResponse.status}): \${errorText}\`);
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
        </script>
    </body>
    </html>
    `;
}
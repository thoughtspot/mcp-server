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

            .warning-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #FFF8E1;
      border: 1px solid #FFE082;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(16, 30, 54, 0.04);
      padding: 12px 16px;
      margin-bottom: 1rem;
    }

    .warning-icon {
      flex-shrink: 0;
      margin-right: 10px;
      align-self: flex-start;
      margin-top: 2px;
    }

    .warning-text {
      flex: 1;
      margin: 0;
      font-size: 14px;
      line-height: 1.4;
      color: #333;
      text-align: left;
      max-width: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }

    .warning-close {
      background: none;
      border: none;
      font-size: 16px;
      line-height: 1;
      color: #999;
      opacity: 0.7;
      cursor: pointer;
      padding: 0;
      align-self: flex-start;
      margin-top: 2px;
      margin-left: 5px;
    }
    .warning-close:hover {
      opacity: 1;
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
        <div id="manual-token-section" style="display:none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #f4f5f7; z-index: 9999; display: flex; flex-direction: column; justify-content: center; align-items: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
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
                            document.getElementById('manual-token-section').style.display = 'flex';
                            document.getElementById('status').textContent = '';
                            document.querySelector('.container').style.display = 'none';
                            
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
                                    const tokenMatch = tokenText.match(/"token"\s*:\s*"([^"]+)"/);
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
                            throw new Error(\`Authentication failed (Status: \${response.status}): \${errorText}\`);
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
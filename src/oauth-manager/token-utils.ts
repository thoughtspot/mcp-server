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
        <div id="manual-token-section" style="display:none; margin-top:2rem;">
            <div style="background: #fff; border: 1.5px solid #d1d9e6; border-radius: 18px; box-shadow: 0 2px 16px 0 rgba(16,30,54,0.10), 0 1.5px 4px 0 rgba(16,30,54,0.06); padding: 2.2rem 1.7rem; max-width: 440px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                <div style="display: flex; align-items: center; gap: 0.7rem; margin-bottom: 1.1rem;">
                    <svg width="28" height="28" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#e3eaf6"/><path d="M12 8v4m0 4h.01" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="#2563eb" stroke-width="2" fill="none"/></svg>
                    <span style="font-size: 1.13rem; color: #2563eb; font-weight: 700;">Manual Token Entry</span>
                </div>
                <div style="margin-bottom: 1.1rem; color: #495057; font-size: 1.01rem; text-align: center;"><span style="display:inline-block; background:#fff3cd; color:#856404; font-weight:600; border-radius:6px; padding:8px 12px; margin-bottom:8px;">Authentication was unsuccessful. This may be due to browser privacy settings, network issues, or strict cookie settings (such as blocking third-party cookies).</span><br>Please open the token URL in a new tab, sign in, and paste the token value or JSON below.</div>
                <button id="open-token-url" style="margin-bottom:1.1rem; padding:12px 0; width:100%; font-size:0.94rem; background: #2563eb; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; transition: background 0.2s; box-shadow: 0 1.5px 4px 0 rgba(16,30,54,0.06);">Open Token URL in New Tab</button>
                <label for="manual-token-input" style="margin-bottom:0.5rem; font-size: 0.97rem; color: #111827; font-weight: 500; align-self: flex-start;">Paste the token JSON or value here:</label>
                <textarea id="manual-token-input" rows="6" style="width:100%; max-width:100%; font-family:monospace; font-size:0.97rem; border: 1.5px solid #d1d5db; border-radius: 8px; padding: 14px 16px; background: #fff; margin-bottom: 0.7rem; resize: vertical; box-sizing: border-box;"></textarea>
                <button id="submit-manual-token" style="margin-top:0.7rem; padding:12px 0; width:100%; font-size:0.94rem; background: #2563eb; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; transition: background 0.2s; box-shadow: 0 1.5px 4px 0 rgba(16,30,54,0.06);">Submit Token</button>
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
                            document.getElementById('manual-token-section').innerHTML = '<div style="background: #fff; border: 1.5px solid #d1d9e6; border-radius: 18px; box-shadow: 0 2px 16px 0 rgba(16,30,54,0.10), 0 1.5px 4px 0 rgba(16,30,54,0.06); padding: 2.2rem 1.7rem; max-width: 440px; margin: 0 auto; display: flex; flex-direction: column; align-items: center;"><div style="display: flex; align-items: center; gap: 0.7rem; margin-bottom: 1.1rem;"><svg width="28" height="28" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#e3eaf6"/><path d="M12 8v4m0 4h.01" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="#2563eb" stroke-width="2" fill="none"/></svg><span style="font-size: 1.13rem; color: #2563eb; font-weight: 700;">Manual Token Entry</span></div><div style="margin-bottom: 1.1rem; color: #495057; font-size: 1.01rem; text-align: center;\"><span style="display:inline-block; background:#fff3cd; color:#856404; font-weight:600; border-radius:6px; padding:8px 12px; margin-bottom:8px;">Authentication was unsuccessful. This may be due to browser privacy settings, network issues, or strict cookie settings (such as blocking third-party cookies).</span><br>Please open the token URL in a new tab, sign in, and paste the token value or JSON below.</div><button id="open-token-url" style="margin-bottom:1.1rem; padding:12px 0; width:100%; font-size:0.94rem; background: #2563eb; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; transition: background 0.2s; box-shadow: 0 1.5px 4px 0 rgba(16,30,54,0.06);\">Open Token URL in New Tab</button><label for="manual-token-input" style="margin-bottom:0.5rem; font-size: 0.97rem; color: #111827; font-weight: 500; align-self: flex-start;\">Paste the token JSON or value here:</label><textarea id="manual-token-input" rows="6" style="width:100%; max-width:100%; font-family:monospace; font-size:0.97rem; border: 1.5px solid #d1d5db; border-radius: 8px; padding: 14px 16px; background: #fff; margin-bottom: 0.7rem; resize: vertical; box-sizing: border-box;\"></textarea><button id="submit-manual-token" style="margin-top:0.7rem; padding:12px 0; width:100%; font-size:0.94rem; background: #2563eb; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; transition: background 0.2s; box-shadow: 0 1.5px 4px 0 rgba(16,30,54,0.06);\">Submit Token</button></div>';
                            document.getElementById('manual-token-section').style.display = 'block';
                            document.getElementById('status').textContent = '';
                            document.querySelector('.container').style.display = 'none';
                            document.getElementById('open-token-url').onclick = function() {
                                window.open(tokenUrl.toString(), '_blank');
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
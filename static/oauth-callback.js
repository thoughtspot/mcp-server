// Immediately invoke the async function
(async function() {
    const oauthReqInfo = JSON.parse(document.getElementById('oauth-req-info').textContent);
    
    // Ensure manual section is hidden initially
    const manualSection = document.getElementById('manual-token-section');
    const container = document.querySelector('.container');
    manualSection.style.display = 'none';

    try {
        // Check if INSTANCE_URL is available and valid
        if (!window.INSTANCE_URL) {
            throw new Error('Instance URL not available. Please ensure you accessed this page through the proper OAuth flow.');
        }

        const base = new URL(window.INSTANCE_URL);
        if (!base.pathname.endsWith('/')) {
            base.pathname += '/';
        }
        const tokenUrl = new URL('callosum/v1/v2/auth/token/fetch?validity_time_in_sec=2592000', base.toString());
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
                
                // Also set the href attribute as a fallback
                document.getElementById('manual-token-url-link').href = tokenUrl.toString();
                
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
                                instanceUrl: window.INSTANCE_URL
                            })
                        });
                        const responseData = await storeResponse.json();
                        if (!storeResponse.ok) {
                            const errorText = await storeResponse.text();
                            throw new Error(`Failed to store token (Status: ${storeResponse.status}): ${errorText}`);
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
                throw new Error(`Authentication failed (Status: ${response.status}): ${errorText}`);
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
            throw new Error(`Failed to store token (Status: ${storeResponse.status}): ${errorText}`);
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
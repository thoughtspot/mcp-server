// Immediately invoke the async function
(async function() {
    // /store-token answers errors in plain text, but fall back gracefully if a
    // JSON body ({ error } or { message }) comes back instead.
    async function readErrorMessage(response) {
        const text = await response.text();
        try {
            const parsed = JSON.parse(text);
            return parsed?.error || parsed?.message || text;
        } catch {
            return text;
        }
    }

    let oauthFlow;

    // Ensure manual section is hidden initially
    const manualSection = document.getElementById('manual-token-section');
    const freeTrialErrorSection = document.getElementById('free-trial-error-section');
    const container = document.querySelector('.container');
    manualSection.style.display = 'none';

    try {
        // Parsed inside try so a malformed block shows an error, not a stuck spinner.
        oauthFlow = JSON.parse(document.getElementById('oauth-flow').textContent);

        // Check the instance URL is available
        if (!oauthFlow.instanceUrl) {
            throw new Error('Instance URL not available. Please ensure you accessed this page through the proper OAuth flow.');
        }

        const base = new URL(oauthFlow.instanceUrl);
        if (!base.pathname.endsWith('/')) {
            base.pathname += '/';
        }
        const tokenUrl = new URL('callosum/v1/session/v2/gettoken?refresh=true', base.toString());
        
        document.getElementById('status').textContent = 'Retrieving authentication token...';
        
        const response = await fetch(tokenUrl.toString(), {
            method: 'GET',
            credentials: 'include'
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                

                // TODO: Remove this once we have a proper way to handle this
                // This is a temporary fix to handle the case where the instance URL is a free trial instance URL
                // Since, free trial does not support IAMv2, the user needs to login to the free trial instance in a separate tab manually.
                if (base.toString().match(/^https:\/\/(?:team|my)\d+\.thoughtspot\.cloud\/?$/)) {
                    freeTrialErrorSection.style.display = 'flex';
                    const errorTextEl = document.getElementById('free-trial-error-text');
                    errorTextEl.textContent = 'Click ';
                    const link = document.createElement('a');
                    link.href = base.toString();
                    link.target = '_blank';
                    link.textContent = 'here';
                    errorTextEl.appendChild(link);
                    errorTextEl.append(' to login to your ThoughtSpot free trial instance in a separate tab and then refresh this page.');
                    return;
                }

                // 401 likely due to 3rd party cookies being blocked
                manualSection.style.display = 'flex';
                document.getElementById('status').textContent = '';
                container.style.display = 'none';
                
                // Set up the token URL link to open in a new tab
                const tokenLink = document.getElementById('manual-token-url-link');
                tokenLink.href = tokenUrl.toString();
                tokenLink.target = '_blank';
                
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
                        if (parsed.data && parsed.data.token) {
                            // Case 2: { data: { token, refreshToken?, ... } }
                            tokenData = { data: {
                                token: parsed.data.token,
                                refreshToken: parsed.data.refreshToken,
                                tokenCreatedTime: parsed.data.tokenCreatedTime,
                                tokenExpiryDuration: parsed.data.tokenExpiryDuration,
                            } };
                        } else if (parsed.token) {
                            // Case 3: { token, refreshToken?, ... }
                            tokenData = { data: {
                                token: parsed.token,
                                refreshToken: parsed.refreshToken,
                                tokenCreatedTime: parsed.tokenCreatedTime,
                                tokenExpiryDuration: parsed.tokenExpiryDuration,
                            } };
                        } else {
                            throw new Error('Unrecognized token format.');
                        }
                    } catch (e) {
                        document.getElementById('status').textContent = 'Invalid token format. Please paste the correct token.';
                        document.getElementById('status').style.color = '#dc3545';
                        return;
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
                                state: oauthFlow.state
                            })
                        });
                        if (!storeResponse.ok) {
                            throw new Error(await readErrorMessage(storeResponse));
                        }
                        const responseData = await storeResponse.json();
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
        
        const raw = await response.json();
        // gettoken returns the access token + refreshToken + timestamps. Normalize
        // to the { data: { token, ... } } shape /store-token expects.
        const src = (raw && raw.data) ? raw.data : raw;
        if (!src || !src.token) {
            // Fail loudly at login rather than storing an undefined token and
            // failing opaquely on the first tool call.
            throw new Error('Authentication response did not contain a token.');
        }
        const data = {
            data: {
                token: src.token,
                refreshToken: src.refreshToken,
                tokenCreatedTime: src.tokenCreatedTime,
                tokenExpiryDuration: src.tokenExpiryDuration,
            },
        };
        document.getElementById('status').textContent = 'Authentication successful. Securing your session...';

        // Send the token to the server
        const storeResponse = await fetch('/store-token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                token: data,
                state: oauthFlow.state
            })
        });
        if (!storeResponse.ok) {
            throw new Error(await readErrorMessage(storeResponse));
        }
        const responseData = await storeResponse.json();

        window.location.href = responseData.redirectTo;
        
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('status').textContent = error.message;
        document.getElementById('status').style.color = '#dc3545';
        document.querySelector('h2').textContent = 'Authorization Failed';
        document.querySelector('.spinner').style.display = 'none';
    }
})(); 
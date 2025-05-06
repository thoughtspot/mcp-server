export function renderTokenCallback(instanceUrl: string, oauthReqInfo: string) {
    // Parse the oauthReqInfo if it's a string
    const parsedOAuthReqInfo = typeof oauthReqInfo === 'string' ? JSON.parse(oauthReqInfo) : oauthReqInfo;

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
        <script>
            // Immediately invoke the async function
            (async function() {
                try {
                    const tokenUrl = new URL('callosum/v1/v2/auth/token/fetch', '${instanceUrl}');
                    console.log('Fetching token from:', tokenUrl.toString());
                    
                    document.getElementById('status').textContent = 'Retrieving authentication token...';
                    
                    const response = await fetch(tokenUrl.toString(), {
                        method: 'GET',
                        credentials: 'include'
                    });
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(\`Authentication failed (Status: \${response.status}): \${errorText}\`);
                    }
                    
                    const data = await response.json();
                    console.log('Token data:', data);
                    document.getElementById('status').textContent = 'Authentication successful. Securing your session...';

                    // Send the token to the server
                    const storeResponse = await fetch('/store-token', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ 
                            token: data,
                            oauthReqInfo: ${JSON.stringify(parsedOAuthReqInfo)},
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
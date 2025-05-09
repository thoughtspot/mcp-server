import type { ClientInfo, AuthRequest } from '@cloudflare/workers-oauth-provider'


/**
 * Configuration for the approval dialog
 */
export interface ApprovalDialogOptions {
    /**
     * Client information to display in the approval dialog
     */
    client: ClientInfo | null
    /**
     * Server information to display in the approval dialog
     */
    server: {
      name: string
      logo?: string
      description?: string
    }
    /**
     * Arbitrary state data to pass through the approval flow
     * Will be encoded in the form and returned when approval is complete
     */
    state: Record<string, any>
    /**
     * Name of the cookie to use for storing approvals
     * @default "mcp_approved_clients"
     */
    cookieName?: string
    /**
     * Secret used to sign cookies for verification
     * Can be a string or Uint8Array
     * @default Built-in Uint8Array key
     */
    cookieSecret?: string | Uint8Array
    /**
     * Cookie domain
     * @default current domain
     */
    cookieDomain?: string
    /**
     * Cookie path
     * @default "/"
     */
    cookiePath?: string
    /**
     * Cookie max age in seconds
     * @default 30 days
     */
    cookieMaxAge?: number
}

/**
 * Renders an approval dialog for OAuth authorization
 * The dialog displays information about the client and server
 * and includes a form to submit approval
 *
 * @param request - The HTTP request
 * @param options - Configuration for the approval dialog
 * @returns A Response containing the HTML approval dialog
 */
export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
    const { client, server, state } = options
  
    // Encode state for form submission
    const encodedState = btoa(JSON.stringify(state))
  
    // Sanitize any untrusted content
    const serverName = sanitizeHtml(server.name)
    const clientName = client?.clientName ? sanitizeHtml(client.clientName) : 'Unknown MCP Client'
    const serverDescription = server.description ? sanitizeHtml(server.description) : ''
  
    // Safe URLs
    const logoUrl = server.logo ? sanitizeHtml(server.logo) : ''
    const clientUri = client?.clientUri ? sanitizeHtml(client.clientUri) : ''
    const policyUri = client?.policyUri ? sanitizeHtml(client.policyUri) : ''
    const tosUri = client?.tosUri ? sanitizeHtml(client.tosUri) : ''
  
    // Client contacts
    const contacts = client?.contacts && client.contacts.length > 0 ? sanitizeHtml(client.contacts.join(', ')) : ''
  
    // Get redirect URIs
    const redirectUris = client?.redirectUris && client.redirectUris.length > 0 ? client.redirectUris.map((uri) => sanitizeHtml(uri)) : []
  
    // Generate HTML for the approval dialog
    const htmlContent = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${clientName} | Authorization Request</title>
          <style>
            /* Modern, formal styling with system fonts */
            :root {
              --primary-color: #1a56db;
              --primary-hover: #1e429f;
              --error-color: #dc2626;
              --border-color: #e5e7eb;
              --text-color: #111827;
              --text-secondary: #4b5563;
              --background-color: #fff;
              --card-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
              --input-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
            }
            
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, 
                          Helvetica, Arial, sans-serif, "Apple Color Emoji", 
                          "Segoe UI Emoji", "Segoe UI Symbol";
              line-height: 1.6;
              color: var(--text-color);
              background-color: #f3f4f6;
              margin: 0;
              padding: 0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            
            .container {
              max-width: 640px;
              width: 100%;
              margin: 2rem;
              padding: 0;
            }
            
            .precard {
              padding: 2.5rem 2rem;
              text-align: center;
              background: linear-gradient(to bottom, #ffffff, #f9fafb);
              border-radius: 12px 12px 0 0;
              border: 1px solid var(--border-color);
              border-bottom: none;
            }
            
            .card {
              background-color: var(--background-color);
              border-radius: 0 0 12px 12px;
              box-shadow: var(--card-shadow);
              padding: 2.5rem;
              border: 1px solid var(--border-color);
              border-top: none;
            }
            
            .header {
              display: flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 1.5rem;
            }
            
            .logo {
              width: 56px;
              height: 56px;
              margin-right: 1rem;
              border-radius: 12px;
              object-fit: contain;
              box-shadow: var(--card-shadow);
            }
            
            .title {
              margin: 0;
              font-size: 1.5rem;
              font-weight: 600;
              color: var(--text-color);
              letter-spacing: -0.025em;
            }
            
            .alert {
              margin: 0;
              font-size: 1.75rem;
              font-weight: 600;
              margin: 1.5rem 0;
              text-align: center;
              color: var(--text-color);
              letter-spacing: -0.025em;
            }
            
            .description {
              color: var(--text-secondary);
              font-size: 1.125rem;
              max-width: 32rem;
              margin: 0 auto;
            }
            
            .form-section {
              margin-top: 2.5rem;
              padding-top: 2rem;
              border-top: 1px solid var(--border-color);
            }
            
            .client-info {
              border: 1px solid var(--border-color);
              border-radius: 8px;
              padding: 1.5rem;
              margin-bottom: 2rem;
              background-color: #f9fafb;
            }
            
            .client-name {
              font-weight: 600;
              font-size: 1.25rem;
              margin: 0 0 1rem 0;
              color: var(--text-color);
            }
            
            .client-detail {
              display: flex;
              margin-bottom: 0.75rem;
              align-items: baseline;
            }
            
            .detail-label {
              font-weight: 500;
              min-width: 140px;
              color: var(--text-secondary);
            }
            
            .detail-value {
              font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
              word-break: break-all;
              color: var(--text-color);
            }
            
            .detail-value a {
              color: var(--primary-color);
              text-decoration: none;
              transition: color 0.2s;
            }
            
            .detail-value a:hover {
              color: var(--primary-hover);
              text-decoration: underline;
            }
            
            .detail-value.small {
              font-size: 0.875em;
            }
            
            .actions {
              display: flex;
              justify-content: flex-end;
              gap: 1rem;
              margin-top: 2.5rem;
            }
            
            .button {
              padding: 0.875rem 1.75rem;
              border-radius: 8px;
              font-weight: 500;
              cursor: pointer;
              border: none;
              font-size: 1rem;
              transition: all 0.2s;
            }
            
            .button-primary {
              background-color: var(--primary-color);
              color: white;
            }
            
            .button-primary:hover {
              background-color: var(--primary-hover);
              transform: translateY(-1px);
            }
            
            .button-secondary {
              background-color: white;
              border: 1px solid var(--border-color);
              color: var(--text-color);
            }
            
            .button-secondary:hover {
              background-color: #f9fafb;
              border-color: #d1d5db;
            }

            .form-group {
              margin-bottom: 2rem;
            }

            .form-group label {
              display: block;
              margin-bottom: 0.75rem;
              font-weight: 500;
              color: var(--text-color);
              font-size: 1.125rem;
            }

            .form-group input {
              width: 100%;
              padding: 0.875rem 1rem;
              border: 1px solid var(--border-color);
              border-radius: 8px;
              font-size: 1rem;
              transition: all 0.2s;
              background-color: white;
              box-shadow: var(--input-shadow);
            }

            .form-group input:focus {
              outline: none;
              border-color: var(--primary-color);
              box-shadow: 0 0 0 3px rgba(26, 86, 219, 0.1);
            }

            .form-group input::placeholder {
              color: #9ca3af;
            }
            
            /* Responsive adjustments */
            @media (max-width: 640px) {
              .container {
                margin: 1rem;
              }
              
              .precard {
                padding: 2rem 1.5rem;
              }
              
              .card {
                padding: 1.5rem;
              }
              
              .client-detail {
                flex-direction: column;
              }
              
              .detail-label {
                min-width: unset;
                margin-bottom: 0.25rem;
              }
              
              .actions {
                flex-direction: column;
              }
              
              .button {
                width: 100%;
              }

              .alert {
                font-size: 1.5rem;
              }

              .description {
                font-size: 1rem;
              }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="precard">
              <div class="header">
                ${logoUrl ? `<img src="${logoUrl}" alt="${serverName} Logo" class="logo">` : ''}
                <h1 class="title">${serverName}</h1>
              </div>
              
              ${serverDescription ? `<p class="description">${serverDescription}</p>` : ''}
            </div>
              
            <div class="card">
              <h2 class="alert">Authorization Request</h2>
              
              <div class="client-info">
                <div class="client-detail">
                  <div class="detail-label">Client Name:</div>
                  <div class="detail-value">
                    ${clientName}
                  </div>
                </div>
                
                ${
                  clientUri
                    ? `
                  <div class="client-detail">
                    <div class="detail-label">Website:</div>
                    <div class="detail-value small">
                      <a href="${clientUri}" target="_blank" rel="noopener noreferrer">
                        ${clientUri}
                      </a>
                    </div>
                  </div>
                `
                    : ''
                }
                
                ${
                  policyUri
                    ? `
                  <div class="client-detail">
                    <div class="detail-label">Privacy Policy:</div>
                    <div class="detail-value">
                      <a href="${policyUri}" target="_blank" rel="noopener noreferrer">
                        ${policyUri}
                      </a>
                    </div>
                  </div>
                `
                    : ''
                }
                
                ${
                  tosUri
                    ? `
                  <div class="client-detail">
                    <div class="detail-label">Terms of Service:</div>
                    <div class="detail-value">
                      <a href="${tosUri}" target="_blank" rel="noopener noreferrer">
                        ${tosUri}
                      </a>
                    </div>
                  </div>
                `
                    : ''
                }
                
                ${
                  redirectUris.length > 0
                    ? `
                  <div class="client-detail">
                    <div class="detail-label">Redirect URIs:</div>
                    <div class="detail-value small">
                      ${redirectUris.map((uri) => `<div>${uri}</div>`).join('')}
                    </div>
                  </div>
                `
                    : ''
                }
                
                ${
                  contacts
                    ? `
                  <div class="client-detail">
                    <div class="detail-label">Contact:</div>
                    <div class="detail-value">${contacts}</div>
                  </div>
                `
                    : ''
                }
              </div>
              
              <p class="description">Please provide your ThoughtSpot instance URL to authorize this client.</p>
              
              <div class="form-section">
                <form method="post" action="${new URL(request.url).pathname}">
                  <input type="hidden" name="state" value="${encodedState}">
                  
                  <div class="form-group">
                    <label for="instanceUrl">ThoughtSpot Instance URL</label>
                    <input type="text" id="instanceUrl" name="instanceUrl" required 
                           placeholder="https://your-instance.thoughtspot.cloud">
                  </div>
                  
                  <div class="actions">
                    <button type="button" class="button button-secondary" onclick="window.history.back()">Cancel</button>
                    <button type="submit" class="button button-primary">Authorize Access</button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </body>
      </html>
    `
  
    return new Response(htmlContent, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    })
}

/**
 * Decodes a base64-encoded state string back into an object
 */
function decodeState<T>(encodedState: string): T {
    try {
        const decoded = atob(encodedState);
        return JSON.parse(decoded) as T;
    } catch (e) {
        console.error('Error decoding state:', e);
        throw new Error('Invalid state format');
    }
}

/**
 * Result of parsing the approval form submission.
 */
export interface ParsedApprovalResult {
    /** The original state object passed through the form. */
    state: any
    /** The instance URL extracted from the form. */
    instanceUrl: string
  }
  

/**
 * Validates and sanitizes a URL to ensure it's a valid ThoughtSpot instance URL
 * @param url - The URL to validate and sanitize
 * @returns The sanitized URL
 * @throws Error if the URL is invalid
 */
function validateAndSanitizeUrl(url: string): string {
    try {
        // Remove any whitespace
        const trimmedUrl = url.trim();
        
        // Add https:// if no protocol is specified
        const urlWithProtocol = trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://') 
            ? trimmedUrl 
            : `https://${trimmedUrl}`;
        
        const parsedUrl = new URL(urlWithProtocol);
        
        // Ensure it's using HTTPS
        if (parsedUrl.protocol !== 'https:') {
            throw new Error('URL must use HTTPS');
        }
        
        // Remove trailing slashes and normalize the URL
        const sanitizedUrl = parsedUrl.origin;
        
        return sanitizedUrl;
    } catch (e) {
        if (e instanceof Error) {
            throw new Error(`Invalid URL: ${e.message}`);
        }
        throw new Error('Invalid URL format');
    }
}

/**
 * Parses the form submission from the approval dialog, extracts the state,
 * and generates Set-Cookie headers to mark the client as approved.
 *
 * @param request - The incoming POST Request object containing the form data.
 * @returns A promise resolving to an object containing the parsed state and necessary headers.
 * @throws If the request method is not POST, form data is invalid, or state is missing.
 */
export async function parseRedirectApproval(request: Request): Promise<ParsedApprovalResult> {
    if (request.method !== 'POST') {
        throw new Error('Invalid request method. Expected POST.')
    }
  
    let state: any
    let clientId: string | undefined
    let instanceUrl: string | undefined
    try {
        const formData = await request.formData()
        const encodedState = formData.get('state')
        const rawInstanceUrl = formData.get('instanceUrl') as string;
  
        if (typeof encodedState !== 'string' || !encodedState) {
            throw new Error("Missing or invalid 'state' in form data.")
        }
  
        state = decodeState<{ oauthReqInfo?: AuthRequest }>(encodedState)
        clientId = state?.oauthReqInfo?.clientId
  
        if (!clientId) {
            throw new Error('Could not extract clientId from state object.')
        }

        if (!rawInstanceUrl) {
            throw new Error('Missing instance URL')
        }

        // Validate and sanitize the instance URL
        instanceUrl = validateAndSanitizeUrl(rawInstanceUrl);
    } catch (e) {
        console.error('Error processing form submission:', e)
        throw new Error(`Failed to parse approval form: ${e instanceof Error ? e.message : String(e)}`)
    }
  
    return { state, instanceUrl }
}

/**
 * Sanitizes HTML content to prevent XSS attacks
 * @param unsafe - The unsafe string that might contain HTML
 * @returns A safe string with HTML special characters escaped
 */
function sanitizeHtml(unsafe: string): string {
    return unsafe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
  }
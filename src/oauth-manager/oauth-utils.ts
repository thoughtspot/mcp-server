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
    const { server, state } = options;
    const encodedState = btoa(JSON.stringify(state));
    const serverName = sanitizeHtml(server.name);
    const mcpLogoUrl = 'https://raw.githubusercontent.com/thoughtspot/mcp-server/refs/heads/main/static/MCP%20Server%20Logo.svg';
    const thoughtspotLogoUrl = 'https://avatars.githubusercontent.com/u/8906680?s=200&v=4';

    const htmlContent = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${serverName} | Authorization Request</title>
          <style>
            html, body {
              height: 100%;
              margin: 0;
              padding: 0;
              background: #f6f7fa;
            }
            body {
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
              color: #111827;
            }
            .approval-card {
              background: #fff;
              border-radius: 18px;
              box-shadow: 0 2px 16px 0 rgba(16,30,54,0.10), 0 1.5px 4px 0 rgba(16,30,54,0.06);
              max-width: 520px;
              width: 100%;
              padding: 40px 32px 32px 32px;
              box-sizing: border-box;
              display: flex;
              flex-direction: column;
              align-items: center;
            }
            .approval-logos {
              display: flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 32px;
              gap: 40px;
            }
            .approval-logo {
              width: 64px;
              height: 64px;
              object-fit: contain;
              background: #fff;
              border-radius: 12px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.04);
            }
            .approval-arrow {
              width: 56px;
              height: 32px;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            .approval-title {
              font-size: 1.25rem;
              font-weight: 700;
              text-align: center;
              margin: 0 0 32px 0;
              line-height: 1.3;
            }
            .approval-form {
              width: 100%;
              display: flex;
              flex-direction: column;
              align-items: stretch;
            }
            .form-group {
              margin-bottom: 28px;
            }
            .form-group label {
              display: block;
              margin-bottom: 8px;
              font-weight: 400;
              font-size: 0.94rem;
              color: #111827;
              transition: color 0.2s;
            }
            .form-group label.label-blue {
              color: #2563eb;
            }
            .form-group label.label-red {
              color: #dc2626;
            }
            .form-group input {
              width: 100%;
              padding: 14px 16px;
              border: 1.5px solid #d1d5db;
              border-radius: 8px;
              font-size: 0.94rem;
              background: #fff;
              box-sizing: border-box;
              transition: border-color 0.2s;
            }
            .form-group input.input-blue {
              border-color: #2563eb;
            }
            .form-group input.input-red {
              border-color: #dc2626;
            }
            .approval-subtitle {
              font-weight: 600;
              font-size: 0.94rem;
              margin-bottom: 8px;
              margin-top: 0;
            }
            .approval-permissions {
              margin: 0 0 32px 0;
              padding: 0 0 0 18px;
              list-style: disc;
              color: #111827;
              font-size: 0.94rem;
            }
            .approval-permissions li {
              margin-bottom: 8px;
              line-height: 1.6;
            }
            .approval-actions {
              display: flex;
              justify-content: space-between;
              gap: 16px;
              margin-bottom: 18px;
            }
            .terms-checkbox {
              margin-bottom: 24px;
              display: flex;
              align-items: flex-start;
              gap: 8px;
            }
            .terms-checkbox input[type="checkbox"] {
              margin-top: 3px;
            }
            .terms-checkbox label {
              font-size: 0.94rem;
              line-height: 1.4;
              color: #111827;
            }
            .terms-checkbox a {
              color: #2563eb;
              text-decoration: none;
            }
            .terms-checkbox a:hover {
              text-decoration: underline;
            }
            .button {
              flex: 1 1 0;
              padding: 12px 0;
              border-radius: 8px;
              font-weight: 500;
              font-size: 0.94rem;
              border: none;
              cursor: pointer;
              transition: background 0.2s, color 0.2s;
            }
            .button-cancel {
              background: #f3f4f6;
              color: #6b7280;
              border: none;
            }
            .button-cancel:hover {
              background: #e5e7eb;
            }
            .button-allow {
              background: #2563eb;
              color: #fff;
              border: none;
            }
            .button-allow:hover {
              background: #1a56db;
            }
            .button-allow:disabled {
              background: #93c5fd;
              cursor: not-allowed;
            }
            .approval-footer {
              text-align: center;
              font-size: 0.88rem;
              color: #111827;
              margin-top: 8px;
            }
            .approval-footer a {
              color: #2563eb;
              text-decoration: none;
              margin-left: 0.25em;
              font-weight: 500;
            }
            .approval-footer a:hover {
              text-decoration: underline;
            }
            @media (max-width: 600px) {
              .approval-card {
                padding: 18px 4vw 18px 4vw;
                max-width: 98vw;
              }
              .approval-logos {
                gap: 18px;
                margin-bottom: 18px;
              }
              .approval-title {
                font-size: 1.1rem;
                margin-bottom: 18px;
              }
            }
          </style>
        </head>
        <body>
          <div class="approval-card">
            <div class="approval-logos">
              <img src="${mcpLogoUrl}" alt="MCP Server Logo" class="approval-logo">
              <span class="approval-arrow">
                <svg width="56" height="32" viewBox="0 0 56 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <g opacity="0.25">
                    <!-- Right arrow -->
                    <line x1="8" y1="10" x2="48" y2="10" stroke="#6B7280" stroke-width="2.5" stroke-linecap="round"/>
                    <polyline points="44,6 48,10 44,14" fill="none" stroke="#6B7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <!-- Left arrow -->
                    <line x1="48" y1="22" x2="8" y2="22" stroke="#6B7280" stroke-width="2.5" stroke-linecap="round"/>
                    <polyline points="12,18 8,22 12,26" fill="none" stroke="#6B7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </g>
                </svg>
              </span>
              <img src="${thoughtspotLogoUrl}" alt="ThoughtSpot Logo" class="approval-logo">
            </div>
            <div class="approval-title">ThoughtSpot MCP Server wants access<br>to your ThoughtSpot instance</div>
            <form class="approval-form" method="post" action="${new URL(request.url).pathname}" id="approvalForm" autocomplete="off" novalidate>
              <div class="form-group">
                <label for="instanceUrl" id="instanceUrlLabel">ThoughtSpot Instance URL</label>
                <input type="text" id="instanceUrl" name="instanceUrl" placeholder="https://your-instance.thoughtspot.cloud" autocomplete="off">
                <input type="hidden" name="state" value="${encodedState}">
              </div>
              <div class="approval-subtitle">ThoughtSpot MCP Server will be able to:</div>
              <ul class="approval-permissions">
                <li>Read all ThoughtSpot data you have access to</li>
                <li>Read all ThoughtSpot content you have access to</li>
                <li>Send data to the client you are connecting to</li>
              </ul>
              <div class="terms-checkbox">
                <input type="checkbox" id="termsCheckbox" name="termsCheckbox" required>
                <label for="termsCheckbox">
                  By checking this box, I acknowledge and agree that my use of this application is subject to the ThoughtSpot
                  <a href="https://www.thoughtspot.com/legal/thoughtspot-for-apps" target="_blank" rel="noopener noreferrer">Terms of Use</a> 
                  and <a href="https://www.thoughtspot.com/privacy-statement" target="_blank" rel="noopener noreferrer">Privacy Statement</a>.
                </label>
              </div>
              <div class="approval-actions">
                <button type="button" class="button button-cancel" onclick="window.history.back()">Cancel</button>
                <button type="submit" class="button button-allow" id="allowButton" disabled>Allow</button>
              </div>
            </form>
            <div class="approval-footer">
              Don't have an account?
              <a href="https://www.thoughtspot.com/trial" target="_blank" rel="noopener noreferrer">Sign up</a>
            </div>
          </div>
          <script>
            const input = document.getElementById('instanceUrl');
            const label = document.getElementById('instanceUrlLabel');
            const form = document.getElementById('approvalForm');
            const termsCheckbox = document.getElementById('termsCheckbox');
            const allowButton = document.getElementById('allowButton');
            let lastError = false;

            function setBlue() {
              input.classList.add('input-blue');
              input.classList.remove('input-red');
              label.classList.add('label-blue');
              label.classList.remove('label-red');
              label.textContent = 'ThoughtSpot Instance URL';
              lastError = false;
            }
            function setRed() {
              input.classList.add('input-red');
              input.classList.remove('input-blue');
              label.classList.add('label-red');
              label.classList.remove('label-blue');
              label.textContent = 'ThoughtSpot Instance URL';
              lastError = true;
            }
            function clearColors() {
              input.classList.remove('input-blue', 'input-red');
              label.classList.remove('label-blue', 'label-red');
              label.textContent = 'ThoughtSpot Instance URL';
              lastError = false;
            }
            function updateAllowButton() {
              allowButton.disabled = !(input.value.trim() && termsCheckbox.checked);
            }
            input.addEventListener('input', function() {
              if (input.value.trim()) {
                setBlue();
              } else {
                clearColors();
              }
              updateAllowButton();
            });
            termsCheckbox.addEventListener('change', updateAllowButton);
            form.addEventListener('submit', function(e) {
              if (!input.value.trim()) {
                e.preventDefault();
                setRed();
                input.focus();
              } else if (!termsCheckbox.checked) {
                e.preventDefault();
                termsCheckbox.focus();
              } else {
                setBlue();
              }
            });
          </script>
        </body>
      </html>
    `;
    return new Response(htmlContent, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
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
export function validateAndSanitizeUrl(url: string): string {
  try {
    // Remove any whitespace
    const trimmedUrl = url.trim();

    // Add https:// if no protocol is specified
    const urlWithProtocol = trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')
      ? trimmedUrl
      : `https://${trimmedUrl}`;

    const parsedUrl = new URL(urlWithProtocol);

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
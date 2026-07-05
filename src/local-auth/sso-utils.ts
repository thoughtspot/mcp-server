// Pure helpers for the interactive SSO login flow. Kept free of Node-only
// imports (node:http, node:child_process) so they remain unit-testable in the
// Workers test pool; the runtime wiring that needs those modules lives in
// sso-login.ts.

// How long the token ThoughtSpot mints for us stays valid (30 days, in seconds).
// Mirrors the value the production OAuth callback uses.
export const TOKEN_VALIDITY_SECONDS = 2_592_000;

/**
 * Escapes a string for safe interpolation into HTML attribute/text content.
 * Mirrors the OAuth flow's `sanitizeHtml`, which moved into
 * `@thoughtspot/mcp-auth` without being exported.
 */
export function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Browser-side script (shared between the manual and callback pages) that turns
 * a pasted token blob into the `{ data: { token } }` shape `/store-token`
 * expects. Returns null when the input is empty so each page can show its own
 * "please paste" message. Kept as one string so the parse + regex-fallback
 * logic lives in a single place.
 */
const TOKEN_PARSE_SCRIPT = `
      function parseTokenData(raw) {
        let tokenData;
        try {
          const jsonText = raw.startsWith('"data"') ? '{' + raw + '}' : raw;
          const parsed = JSON.parse(jsonText);
          if (typeof parsed === 'string') tokenData = { data: { token: parsed } };
          else if (parsed.data && parsed.data.token) tokenData = { data: { token: parsed.data.token } };
          else if (parsed.token) tokenData = { data: { token: parsed.token } };
          else throw new Error('Unrecognized token format.');
        } catch (e) {
          const m = raw.match(/"token"\\s*:\\s*"([^"]+)"/);
          if (m) tokenData = { data: { token: m[1] } };
          else if (raw.length > 0) tokenData = { data: { token: raw } };
          else return null;
        }
        return tokenData;
      }`;

/**
 * Builds the cluster SAML login URL, instructing ThoughtSpot to redirect back to
 * our loopback callback once the user has authenticated with their IdP.
 */
export function buildSamlLoginUrl(base: string, callbackUrl: string): string {
	const loginUrl = new URL("callosum/v1/saml/login", `${base}/`);
	loginUrl.searchParams.set("targetURLPath", callbackUrl);
	return loginUrl.toString();
}

/**
 * Builds the endpoint that exchanges an authenticated SSO session for a bearer
 * token.
 */
export function buildTokenFetchUrl(base: string): string {
	return `${base}/callosum/v1/v2/auth/token/fetch?validity_time_in_sec=${TOKEN_VALIDITY_SECONDS}`;
}

/**
 * Pulls the bearer token out of a parsed `/store-token` body. Accepts both the
 * raw token-fetch shape (`{ token: { data: { token } } }`) and a flat
 * `{ token }` form, returning null when neither yields a usable string.
 */
export function extractToken(parsedBody: any): string | null {
	const token = parsedBody?.token?.data?.token ?? parsedBody?.token;
	return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * Maps the current platform to the command + args that open a URL in the user's
 * default browser.
 */
export function getBrowserCommand(
	platform: NodeJS.Platform,
	targetUrl: string,
): { cmd: string; args: string[] } {
	if (platform === "darwin") {
		return { cmd: "open", args: [targetUrl] };
	}
	if (platform === "win32") {
		return { cmd: "cmd", args: ["/c", "start", "", targetUrl] };
	}
	return { cmd: "xdg-open", args: [targetUrl] };
}

/**
 * The landing page served on the loopback origin. It asks the user which
 * ThoughtSpot cluster to sign in to (prefilled from TS_INSTANCE when provided),
 * then submits to `/start`, which redirects the browser into the cluster's SSO.
 */
export function renderInstancePage(
	defaultInstanceUrl = "",
	errorMessage = "",
): string {
	const value = escapeHtml(defaultInstanceUrl);
	const error = errorMessage
		? `<p class="error">${escapeHtml(errorMessage)}</p>`
		: "";
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ThoughtSpot SSO Login</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f8f9fa; color: #2c3e50; }
    .card { background: #fff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 520px; width: 90%; }
    h2 { margin-top: 0; }
    label { display: block; font-weight: 600; margin-bottom: 0.4rem; }
    input { width: 100%; box-sizing: border-box; padding: 0.6rem; font-size: 1rem; border: 1px solid #ccd; border-radius: 6px; }
    button { margin-top: 1rem; padding: 0.6rem 1.2rem; border: none; border-radius: 6px; background: #2770ef; color: #fff; font-size: 1rem; cursor: pointer; }
    button.secondary { background: #fff; color: #2770ef; border: 1px solid #2770ef; margin-left: 0.5rem; }
    code { background: #f0f0f5; padding: 0.1rem 0.3rem; border-radius: 4px; }
    .hint { color: #6c757d; font-size: 0.85rem; margin-top: 0.4rem; }
    .error { color: #dc3545; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Sign in to ThoughtSpot</h2>
    ${error}
    <form method="get">
      <label for="instanceUrl">Cluster URL</label>
      <input id="instanceUrl" name="instanceUrl" type="text" value="${value}" placeholder="https://my-cluster.thoughtspot.cloud" autofocus required />
      <p class="hint">Enter the ThoughtSpot cluster you want to sign in to.</p>
      <button type="submit" formaction="/start">Continue to SSO</button>
      <button type="submit" formaction="/manual" class="secondary">Manual sign-in (no admin)</button>
      <p class="hint">Use <strong>Continue to SSO</strong> if your cluster admin has whitelisted <code>localhost</code> as a SAML redirect domain. Otherwise use <strong>Manual sign-in</strong>.</p>
    </form>
  </div>
</body>
</html>`;
}

/**
 * The manual sign-in page. Used when the cluster has not whitelisted localhost
 * as a SAML redirect domain (so the automatic flow would 403). It avoids the
 * loopback redirect entirely: the user signs in to the cluster normally, opens
 * the token page same-origin (no CORS), copies the token, and pastes it here.
 */
export function renderManualPage(base: string): string {
	const tokenUrl = buildTokenFetchUrl(base);
	const safeBase = escapeHtml(base);
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ThoughtSpot SSO Login — Manual</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f8f9fa; color: #2c3e50; }
    .card { background: #fff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 560px; width: 90%; }
    h2 { margin-top: 0; }
    ol { padding-left: 1.2rem; }
    li { margin-bottom: 0.6rem; }
    textarea { width: 100%; min-height: 90px; box-sizing: border-box; font-family: monospace; }
    button { margin-top: 0.75rem; padding: 0.6rem 1.2rem; border: none; border-radius: 6px; background: #2770ef; color: #fff; font-size: 1rem; cursor: pointer; }
    a { color: #2770ef; }
    .error { color: #dc3545; }
    .status { margin-top: 0.75rem; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Manual sign-in</h2>
    <ol>
      <li>Make sure you are signed in to <a href="${safeBase}" target="_blank" rel="noopener">${safeBase}</a> (open it and log in if needed).</li>
      <li>Open the <a id="token-link" href="${tokenUrl}" target="_blank" rel="noopener">token page</a> and copy the entire response.</li>
      <li>Paste it below and submit.</li>
    </ol>
    <textarea id="token-input" placeholder='{"data":{"token":"..."}}'></textarea>
    <button id="submit">Submit token</button>
    <p id="status" class="status"></p>
  </div>
  <script>
    (function () {
      const statusEl = document.getElementById('status');
${TOKEN_PARSE_SCRIPT}

      async function storeToken(tokenData) {
        const res = await fetch('/store-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: tokenData }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error('Failed to store token: ' + text);
        }
      }

      document.getElementById('submit').onclick = async function () {
        const raw = document.getElementById('token-input').value.trim();
        const tokenData = parseTokenData(raw);
        if (!tokenData) { statusEl.textContent = 'Please paste the token.'; statusEl.className = 'status error'; return; }
        try {
          await storeToken(tokenData);
          statusEl.textContent = 'Sign-in complete. You can close this tab and return to your terminal.';
          statusEl.className = 'status';
        } catch (err) {
          statusEl.textContent = err.message;
          statusEl.className = 'status error';
        }
      };
    })();
  </script>
</body>
</html>`;
}

/**
 * The callback page served on the loopback origin after SSO completes. It
 * exchanges the SSO session cookie for a bearer token and posts it back to the
 * loopback server, with a manual-paste fallback when the credentialed token
 * fetch is blocked.
 */
export function renderCallbackPage(base: string): string {
	const tokenUrl = buildTokenFetchUrl(base);
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ThoughtSpot SSO Login</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f8f9fa; color: #2c3e50; }
    .card { background: #fff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 520px; width: 90%; text-align: center; }
    h2 { margin-top: 0; }
    #manual { display: none; text-align: left; margin-top: 1rem; }
    textarea { width: 100%; min-height: 90px; box-sizing: border-box; font-family: monospace; }
    button { margin-top: 0.75rem; padding: 0.5rem 1rem; border: none; border-radius: 6px; background: #2770ef; color: #fff; cursor: pointer; }
    a { color: #2770ef; }
    .error { color: #dc3545; }
  </style>
</head>
<body>
  <div class="card">
    <h2 id="title">Completing sign-in…</h2>
    <p id="status">Retrieving your authentication token…</p>
    <div id="manual">
      <p class="error">Could not retrieve the token automatically (your cluster may block this).</p>
      <p>Open <a id="token-link" href="${tokenUrl}" target="_blank" rel="noopener">this link</a>, copy the full response, and paste it below.</p>
      <textarea id="token-input" placeholder='{"data":{"token":"..."}}'></textarea>
      <button id="submit">Submit token</button>
    </div>
  </div>
  <script>
    (async function () {
      const tokenUrl = ${JSON.stringify(tokenUrl)};
      const statusEl = document.getElementById('status');
      const titleEl = document.getElementById('title');
${TOKEN_PARSE_SCRIPT}

      async function storeToken(tokenData) {
        const res = await fetch('/store-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: tokenData }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error('Failed to store token: ' + text);
        }
      }

      function showSuccess() {
        titleEl.textContent = 'Sign-in complete';
        statusEl.textContent = 'You can close this tab and return to your terminal.';
        document.getElementById('manual').style.display = 'none';
      }

      function showManual() {
        document.getElementById('manual').style.display = 'block';
        statusEl.textContent = '';
        document.getElementById('submit').onclick = async function () {
          const raw = document.getElementById('token-input').value.trim();
          const tokenData = parseTokenData(raw);
          if (!tokenData) { statusEl.textContent = 'Please paste the token.'; statusEl.className = 'error'; return; }
          try {
            await storeToken(tokenData);
            showSuccess();
          } catch (err) {
            statusEl.textContent = err.message;
            statusEl.className = 'error';
          }
        };
      }

      try {
        const res = await fetch(tokenUrl, { method: 'GET', credentials: 'include' });
        if (!res.ok) { showManual(); return; }
        const data = await res.json();
        await storeToken(data);
        showSuccess();
      } catch (e) {
        showManual();
      }
    })();
  </script>
</body>
</html>`;
}

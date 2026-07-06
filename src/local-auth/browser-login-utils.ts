// Pure helpers for the browser sign-in flow. Free of Node-only imports so they
// stay unit-testable in the Workers test pool; runtime wiring lives in
// browser-login.ts. The server itself never authenticates to the cluster — the
// user's browser session mints the token, which they paste back here.

// Token validity (30 days); mirrors the production OAuth callback.
export const TOKEN_VALIDITY_SECONDS = 2_592_000;

// HTML-escapes a string; mirrors mcp-auth's unexported `sanitizeHtml`.
export function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

// Browser-side script turning a pasted token blob into the `{ data: { token } }`
// shape; null when empty.
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

// Endpoint that exchanges an authenticated browser session for a bearer token.
export function buildTokenFetchUrl(base: string): string {
	return `${base}/callosum/v1/v2/auth/token/fetch?validity_time_in_sec=${TOKEN_VALIDITY_SECONDS}`;
}

// Pulls the token from a `/store-token` body: nested token-fetch shape or
// flat `{ token }`; null when neither yields a usable string.
export function extractToken(parsedBody: any): string | null {
	const token = parsedBody?.token?.data?.token ?? parsedBody?.token;
	return typeof token === "string" && token.length > 0 ? token : null;
}

// Platform-specific command to open a URL in the default browser.
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

// Landing page: pick / confirm the cluster, then continue to the token page.
export function renderInstancePage(
	defaultInstanceUrl = "",
	errorMessage = "",
	nonce = "",
): string {
	const value = escapeHtml(defaultInstanceUrl);
	const safeNonce = escapeHtml(nonce);
	const error = errorMessage
		? `<p class="error">${escapeHtml(errorMessage)}</p>`
		: "";
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ThoughtSpot Sign-in</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f8f9fa; color: #2c3e50; }
    .card { background: #fff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 520px; width: 90%; }
    h2 { margin-top: 0; }
    label { display: block; font-weight: 600; margin-bottom: 0.4rem; }
    input { width: 100%; box-sizing: border-box; padding: 0.6rem; font-size: 1rem; border: 1px solid #ccd; border-radius: 6px; }
    button { margin-top: 1rem; padding: 0.6rem 1.2rem; border: none; border-radius: 6px; background: #2770ef; color: #fff; font-size: 1rem; cursor: pointer; }
    .hint { color: #6c757d; font-size: 0.85rem; margin-top: 0.4rem; }
    .error { color: #dc3545; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Sign in to ThoughtSpot</h2>
    ${error}
    <form method="get" action="/manual">
      <input type="hidden" name="nonce" value="${safeNonce}" />
      <label for="instanceUrl">Cluster URL</label>
      <input id="instanceUrl" name="instanceUrl" type="text" value="${value}" placeholder="https://my-cluster.thoughtspot.cloud" autofocus required />
      <p class="hint">Enter the ThoughtSpot cluster you want to sign in to.</p>
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`;
}

// Token page: the user is already signed in to the cluster in their browser, so
// the token page returns a token; they copy it and paste it back here.
export function renderManualPage(base: string, nonce = ""): string {
	// `base` is a sanitized https origin; escaping is defense in depth.
	const tokenUrl = escapeHtml(buildTokenFetchUrl(base));
	const safeBase = escapeHtml(base);
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ThoughtSpot Sign-in — Token</title>
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
    <h2>Sign in</h2>
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
          body: JSON.stringify({ token: tokenData, nonce: ${JSON.stringify(nonce)} }),
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

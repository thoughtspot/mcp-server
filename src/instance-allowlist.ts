import { validateAndSanitizeUrl } from "@thoughtspot/mcp-auth";
import { PUBLIC_ROUTES } from "./routes";

/**
 * Per-hostname allowlist of ThoughtSpot instances. JSON object mapping the
 * hostname a request arrives on to the instance URLs permitted for it, e.g.
 * {"test-champ.thoughtspot.app": ["https://champagne.thoughtspotstaging.cloud"]}
 * Hosts not present in the map are unrestricted.
 */
export const INSTANCE_ALLOWLIST_ENV_VAR = "INSTANCE_ALLOWLIST_BY_HOST";

export const INSTANCE_NOT_PERMITTED_MESSAGE =
	"This ThoughtSpot instance is not permitted on this endpoint.";
export const ALLOWLIST_MISCONFIGURED_MESSAGE = "Internal Server Error";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_SERVER_ERROR = 500;

const INSTANCE_URL_FIELD = "instanceUrl";
const FORM_URLENCODED_CONTENT_TYPE = "application/x-www-form-urlencoded";
const MULTIPART_FORM_CONTENT_TYPE = "multipart/form-data";
const INSTANCE_URL_INPUT_SELECTOR = `input#${INSTANCE_URL_FIELD}`;
const FREE_TRIAL_FOOTER_SELECTOR = ".free-trial-footer";
const HEAD_SELECTOR = "head";
const BODY_SELECTOR = "body";

// Keeps the dropdown's tooltip on the selected URL so a value truncated by the
// box width can still be read in full on hover.
const INSTANCE_SELECT_TOOLTIP_SCRIPT = `<script>
(function () {
  var select = document.getElementById("${INSTANCE_URL_FIELD}");
  if (!select) return;
  function syncTitle() { select.title = select.value; }
  select.addEventListener("change", syncTitle);
  syncTitle();
})();
</script>`;

// The auth package only styles `.form-group input`; mirror its box so the
// dropdown matches the text field it replaces, with a chevron making clear
// the choices are a fixed, approved list.
const INSTANCE_SELECT_STYLE = `<style>
.form-group select { width: 100%; padding: 14px 44px 14px 16px; border: 1.5px solid #d1d5db; border-radius: 8px; font-size: 0.94rem; font-family: inherit; font-weight: 500; color: #111827; background: #f8fafc url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%232563eb' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E") no-repeat right 16px center; -webkit-appearance: none; appearance: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; box-sizing: border-box; transition: border-color 0.2s, box-shadow 0.2s; }
.form-group select:hover { border-color: #93c5fd; }
.form-group select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15); }
.form-group select.input-blue { border-color: #2563eb; }
.form-group select.input-red { border-color: #dc2626; }
.form-group select option { color: #111827; background: #fff; }
.form-group input.instance-fixed { font-weight: 500; color: #111827; background: #f8fafc; cursor: default; text-overflow: ellipsis; }
.form-group input.instance-fixed:focus { outline: none; border-color: #d1d5db; }
</style>`;

export type InstanceAllowlist = Map<string, string[]>;

type EnvWithAllowlist = Record<string, unknown>;

type FetchHandler = (
	request: Request,
	env: any,
	ctx: ExecutionContext,
) => Promise<Response>;

export class InstanceAllowlistConfigError extends Error {}

let cachedRaw: unknown;
let cachedAllowlist: InstanceAllowlist = new Map();

/**
 * Reduces a configured host key to a bare hostname, so "https://Host.app/" and
 * "host.app:443" both match requests to host.app.
 */
function normalizeHostKey(key: string): string {
	const trimmed = key.trim();
	const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
	try {
		return new URL(withScheme).hostname.toLowerCase();
	} catch {
		throw new InstanceAllowlistConfigError(
			`${INSTANCE_ALLOWLIST_ENV_VAR} has an invalid hostname key "${key}"`,
		);
	}
}

/**
 * Parses the allowlist env var. Accepts a JSON string (plain-text var) or an
 * already-parsed object (JSON-typed var). Throws InstanceAllowlistConfigError
 * on malformed config so callers can fail closed rather than silently lifting
 * the restriction.
 */
export function parseInstanceAllowlist(raw?: unknown): InstanceAllowlist {
	if (raw === undefined || raw === null || raw === "") {
		return new Map();
	}
	if (typeof raw === "string" && !raw.trim()) {
		return new Map();
	}
	if (raw === cachedRaw) {
		return cachedAllowlist;
	}

	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new InstanceAllowlistConfigError(
				`${INSTANCE_ALLOWLIST_ENV_VAR} is not valid JSON: ${(error as Error).message}`,
			);
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new InstanceAllowlistConfigError(
			`${INSTANCE_ALLOWLIST_ENV_VAR} must be a JSON object of hostname -> URL[]`,
		);
	}

	const allowlist: InstanceAllowlist = new Map();
	for (const [host, urls] of Object.entries(parsed)) {
		if (
			!Array.isArray(urls) ||
			urls.length === 0 ||
			urls.some((url) => typeof url !== "string")
		) {
			throw new InstanceAllowlistConfigError(
				`${INSTANCE_ALLOWLIST_ENV_VAR} entry for "${host}" must be a non-empty array of URLs`,
			);
		}
		try {
			allowlist.set(
				normalizeHostKey(host),
				urls.map((url: string) => validateAndSanitizeUrl(url)),
			);
		} catch (error) {
			if (error instanceof InstanceAllowlistConfigError) {
				throw error;
			}
			throw new InstanceAllowlistConfigError(
				`${INSTANCE_ALLOWLIST_ENV_VAR} entry for "${host}": ${(error as Error).message}`,
			);
		}
	}

	cachedRaw = raw;
	cachedAllowlist = allowlist;
	return allowlist;
}

/**
 * Returns the instances permitted for the request's hostname, or undefined when
 * the hostname is unrestricted.
 */
export function getAllowedInstances(
	request: Request,
	env: EnvWithAllowlist | undefined,
): string[] | undefined {
	const allowlist = parseInstanceAllowlist(env?.[INSTANCE_ALLOWLIST_ENV_VAR]);
	return allowlist.get(new URL(request.url).hostname.toLowerCase());
}

/** Exact origin match after normalization; never substring matching. */
export function isInstanceAllowed(
	instanceUrl: string | undefined,
	allowed: string[],
): boolean {
	if (!instanceUrl) {
		return false;
	}
	try {
		return allowed.includes(validateAndSanitizeUrl(instanceUrl));
	} catch {
		return false;
	}
}

/**
 * Guard for MCP transport requests: returns a 403 response when the request
 * host is restricted and the authenticated instance is not on its allowlist,
 * or undefined when the request may proceed.
 */
export function checkMcpInstanceAllowed(
	request: Request,
	env: EnvWithAllowlist | undefined,
	instanceUrl: string | undefined,
): Response | undefined {
	let allowed: string[] | undefined;
	try {
		allowed = getAllowedInstances(request, env);
	} catch (error) {
		console.error("Invalid instance allowlist configuration", error);
		return new Response(ALLOWLIST_MISCONFIGURED_MESSAGE, {
			status: HTTP_INTERNAL_SERVER_ERROR,
		});
	}
	if (!allowed || isInstanceAllowed(instanceUrl, allowed)) {
		return undefined;
	}
	console.error(
		"Rejecting MCP request for instance not in host allowlist",
		instanceUrl,
	);
	return new Response(INSTANCE_NOT_PERMITTED_MESSAGE, {
		status: HTTP_FORBIDDEN,
	});
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * A single permitted instance is shown as a pre-filled read-only field (a
 * dropdown with one entry would suggest a choice that doesn't exist); readonly
 * fields are still submitted, so no hidden input is needed.
 */
function renderFixedInstance(url: string): string {
	const escaped = escapeHtml(url);
	return `<input type="text" id="${INSTANCE_URL_FIELD}" name="${INSTANCE_URL_FIELD}" class="instance-fixed" value="${escaped}" title="${escaped}" readonly>`;
}

function renderInstanceSelect(allowed: string[]): string {
	if (allowed.length === 1) {
		return renderFixedInstance(allowed[0]);
	}
	const options = allowed
		.map((url) => {
			const escaped = escapeHtml(url);
			return `<option value="${escaped}" title="${escaped}">${escaped}</option>`;
		})
		.join("");
	return `<select id="${INSTANCE_URL_FIELD}" name="${INSTANCE_URL_FIELD}" title="${escapeHtml(allowed[0])}">${options}</select>`;
}

function rewriteApprovalDialog(
	response: Response,
	allowed: string[],
): Response {
	const contentType = response.headers.get("content-type") ?? "";
	if (!response.ok || !contentType.includes("text/html")) {
		return response;
	}
	return new HTMLRewriter()
		.on(INSTANCE_URL_INPUT_SELECTOR, {
			element(element) {
				element.replace(renderInstanceSelect(allowed), { html: true });
			},
		})
		.on(HEAD_SELECTOR, {
			element(element) {
				element.append(INSTANCE_SELECT_STYLE, { html: true });
			},
		})
		.on(BODY_SELECTOR, {
			element(element) {
				element.append(INSTANCE_SELECT_TOOLTIP_SCRIPT, { html: true });
			},
		})
		.on(FREE_TRIAL_FOOTER_SELECTOR, {
			element(element) {
				element.remove();
			},
		})
		.transform(response);
}

async function isApprovalSubmissionAllowed(
	request: Request,
	allowed: string[],
): Promise<boolean> {
	// The approval dialog always posts a form; anything else can't carry a
	// valid instanceUrl, so reject it without parsing the body.
	const contentType = request.headers.get("content-type") ?? "";
	if (
		!contentType.includes(FORM_URLENCODED_CONTENT_TYPE) &&
		!contentType.includes(MULTIPART_FORM_CONTENT_TYPE)
	) {
		return false;
	}
	try {
		const formData = await request.clone().formData();
		const instanceUrl = formData.get(INSTANCE_URL_FIELD);
		return (
			typeof instanceUrl === "string" && isInstanceAllowed(instanceUrl, allowed)
		);
	} catch (error) {
		console.error("Failed to read authorize form submission", error);
		return false;
	}
}

/**
 * mcp-auth 2.x passes the instance through the browser after /authorize: in
 * the /callback query string and the /store-token JSON body. Validate those
 * too, so a caller can't skip /authorize and mint a grant for another
 * instance. Newer auth versions keep the instance server-side and omit the
 * field, so an absent value is left for the auth package to handle.
 */
function isCallbackAllowed(request: Request, allowed: string[]): boolean {
	const instanceUrl = new URL(request.url).searchParams.get(INSTANCE_URL_FIELD);
	return instanceUrl === null || isInstanceAllowed(instanceUrl, allowed);
}

async function isStoreTokenAllowed(
	request: Request,
	allowed: string[],
): Promise<boolean> {
	let body: unknown;
	try {
		body = await request.clone().json();
	} catch {
		// Unparseable bodies are rejected by the auth package itself.
		return true;
	}
	const instanceUrl =
		body && typeof body === "object"
			? (body as Record<string, unknown>)[INSTANCE_URL_FIELD]
			: undefined;
	if (instanceUrl === undefined || instanceUrl === null) {
		return true;
	}
	return (
		typeof instanceUrl === "string" && isInstanceAllowed(instanceUrl, allowed)
	);
}

const GUARDED_AUTH_PATHS: ReadonlySet<string> = new Set([
	PUBLIC_ROUTES.authorize,
	PUBLIC_ROUTES.callback,
	PUBLIC_ROUTES.storeToken,
]);

async function isAuthStepAllowed(
	request: Request,
	pathname: string,
	allowed: string[],
): Promise<boolean> {
	if (pathname === PUBLIC_ROUTES.callback) {
		return request.method !== "GET" || isCallbackAllowed(request, allowed);
	}
	if (pathname === PUBLIC_ROUTES.storeToken) {
		return (
			request.method !== "POST" || (await isStoreTokenAllowed(request, allowed))
		);
	}
	return (
		request.method !== "POST" ||
		(await isApprovalSubmissionAllowed(request, allowed))
	);
}

/**
 * Restricts the OAuth flow on hosts with an instance allowlist: GET /authorize
 * renders a dropdown of the permitted instances instead of a free-text field,
 * and every step that carries an instance (POST /authorize, GET /callback,
 * POST /store-token) rejects one outside the allowlist before the auth package
 * acts on it.
 */
export function withInstanceAllowlist(handler: FetchHandler): FetchHandler {
	return async (request, env, ctx) => {
		const { pathname } = new URL(request.url);
		if (!GUARDED_AUTH_PATHS.has(pathname)) {
			return handler(request, env, ctx);
		}

		let allowed: string[] | undefined;
		try {
			allowed = getAllowedInstances(request, env);
		} catch (error) {
			console.error("Invalid instance allowlist configuration", error);
			return new Response(ALLOWLIST_MISCONFIGURED_MESSAGE, {
				status: HTTP_INTERNAL_SERVER_ERROR,
			});
		}
		if (!allowed) {
			return handler(request, env, ctx);
		}

		if (!(await isAuthStepAllowed(request, pathname, allowed))) {
			return new Response(INSTANCE_NOT_PERMITTED_MESSAGE, {
				status: HTTP_BAD_REQUEST,
			});
		}

		const response = await handler(request, env, ctx);
		return pathname === PUBLIC_ROUTES.authorize && request.method === "GET"
			? rewriteApprovalDialog(response, allowed)
			: response;
	};
}

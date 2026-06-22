import { spawn } from "node:child_process";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { validateAndSanitizeUrl } from "../oauth-manager/oauth-utils";
import {
	buildSamlLoginUrl,
	extractToken,
	getBrowserCommand,
	renderCallbackPage,
	renderInstancePage,
	renderManualPage,
} from "./sso-utils";

// How long we wait for the user to finish the browser SSO flow before giving up.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface SSOLoginResult {
	instanceUrl: string;
	accessToken: string;
}

/**
 * Performs an interactive SSO login and returns the chosen cluster URL together
 * with a bearer token usable for subsequent API calls.
 *
 * This mirrors the production Cloudflare Worker OAuth flow, but for a local
 * (stdio) process. It spins up a short-lived loopback HTTP server and opens the
 * browser to a landing page where the user picks (or confirms) the cluster URL.
 * Submitting redirects the browser into that cluster's SAML login; on return,
 * the callback page exchanges the SSO session cookie for a bearer token via
 * `/callosum/v1/v2/auth/token/fetch` and posts it back to the loopback server,
 * which resolves it to the caller.
 *
 * `defaultInstanceUrl` (from TS_INSTANCE) is only used to prefill the landing
 * page — the user can always change it, so any cluster can be targeted.
 *
 * If the cluster blocks the cross-origin credentialed token fetch (CORS / 3rd
 * party cookies), the callback page falls back to a manual paste box — the same
 * fallback the production flow uses.
 */
export function loginWithSSO(defaultInstanceUrl = ""): Promise<SSOLoginResult> {
	return new Promise<SSOLoginResult>((resolve, reject) => {
		let settled = false;
		// The cluster the user picked on the landing page (already sanitized).
		let chosenInstanceUrl = "";
		// The loopback origin (http://localhost:<port>), known once listening.
		let loopbackOrigin = "";

		const finish = (err: Error | null, token?: string) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			server.close();
			if (err) {
				reject(err);
			} else {
				resolve({
					instanceUrl: chosenInstanceUrl,
					accessToken: token as string,
				});
			}
		};

		const server = createServer((req, res) => {
			handleRequest(req, res, {
				defaultInstanceUrl,
				loopbackOrigin,
				getChosenInstanceUrl: () => chosenInstanceUrl,
				setChosenInstanceUrl: (url) => {
					chosenInstanceUrl = url;
				},
				finish,
			}).catch((err) => {
				res.statusCode = 500;
				res.end("Internal error");
				finish(err instanceof Error ? err : new Error(String(err)));
			});
		});

		const timer = setTimeout(() => {
			finish(
				new Error(`SSO login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`),
			);
		}, LOGIN_TIMEOUT_MS);

		server.on("error", (err) => finish(err));

		// Bind to an ephemeral port on loopback only.
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			loopbackOrigin = `http://localhost:${port}`;
			const landingUrl = `${loopbackOrigin}/`;

			console.error(
				"[ThoughtSpot MCP] Opening browser to choose a cluster and sign in via SSO ...",
			);
			console.error(
				`[ThoughtSpot MCP] If the browser does not open, visit:\n${landingUrl}`,
			);
			openBrowser(landingUrl);
		});
	});
}

interface RequestHandlerContext {
	defaultInstanceUrl: string;
	loopbackOrigin: string;
	getChosenInstanceUrl: () => string;
	setChosenInstanceUrl: (url: string) => void;
	finish: (err: Error | null, token?: string) => void;
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RequestHandlerContext,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");

	// Landing page: pick / confirm the cluster URL.
	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(renderInstancePage(ctx.defaultInstanceUrl));
		return;
	}

	// Form submission: validate the cluster URL and redirect into its SSO.
	if (req.method === "GET" && url.pathname === "/start") {
		const sanitized = sanitizeInstanceUrlOrRespond(req, res);
		if (!sanitized) {
			return;
		}
		ctx.setChosenInstanceUrl(sanitized);

		const callbackUrl = `${ctx.loopbackOrigin}/callback?instanceUrl=${encodeURIComponent(sanitized)}`;
		const loginUrl = buildSamlLoginUrl(sanitized, callbackUrl);

		res.writeHead(302, { Location: loginUrl });
		res.end();
		return;
	}

	// Manual path: no localhost SAML redirect (works without cluster whitelisting).
	if (req.method === "GET" && url.pathname === "/manual") {
		const sanitized = sanitizeInstanceUrlOrRespond(req, res);
		if (!sanitized) {
			return;
		}
		ctx.setChosenInstanceUrl(sanitized);

		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(renderManualPage(sanitized));
		return;
	}

	// Post-SSO landing: exchange the session cookie for a token in the browser.
	if (req.method === "GET" && url.pathname === "/callback") {
		// Prefer the cluster the user picked during /start or /manual (already
		// sanitized). Fall back to the query param only after re-validating it —
		// a forged callback URL must not inject an unchecked origin into the
		// rendered page's credentialed fetch / links.
		let instanceUrl = ctx.getChosenInstanceUrl();
		if (!instanceUrl) {
			const raw = url.searchParams.get("instanceUrl") ?? "";
			try {
				instanceUrl = raw ? validateAndSanitizeUrl(raw) : "";
			} catch {
				instanceUrl = "";
			}
		}
		if (!instanceUrl) {
			res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				renderInstancePage("", "Missing cluster URL; please start over."),
			);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(renderCallbackPage(instanceUrl));
		return;
	}

	if (req.method === "POST" && url.pathname === "/store-token") {
		const body = await readBody(req);
		let token: string | null;
		try {
			token = extractToken(JSON.parse(body));
		} catch {
			token = null;
		}

		if (!token) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "Missing token" }));
			return;
		}

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		ctx.finish(null, token);
		return;
	}

	res.writeHead(404);
	res.end("Not found");
}

/**
 * Reads & sanitizes the `instanceUrl` query param. On failure, writes a 400 with
 * the landing page (showing the error) and returns null so the caller bails.
 */
function sanitizeInstanceUrlOrRespond(
	req: IncomingMessage,
	res: ServerResponse,
): string | null {
	const url = new URL(req.url ?? "/", "http://localhost");
	const raw = url.searchParams.get("instanceUrl") ?? "";
	try {
		return validateAndSanitizeUrl(raw);
	} catch (e) {
		res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
		res.end(
			renderInstancePage(
				raw,
				e instanceof Error ? e.message : "Invalid cluster URL",
			),
		);
		return null;
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

/**
 * Opens the given URL in the user's default browser. Best-effort: failures are
 * non-fatal because the login URL is also printed to stderr.
 */
function openBrowser(targetUrl: string): void {
	const { cmd, args } = getBrowserCommand(process.platform, targetUrl);

	try {
		const child = spawn(cmd, args, {
			stdio: "ignore",
			detached: true,
		});
		child.on("error", () => {
			// Ignore — the URL was printed to stderr as a fallback.
		});
		child.unref();
	} catch {
		// Ignore — the URL was printed to stderr as a fallback.
	}
}

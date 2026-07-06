import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { validateAndSanitizeUrl } from "@thoughtspot/mcp-auth";
import {
	extractToken,
	getBrowserCommand,
	renderInstancePage,
	renderManualPage,
} from "./browser-login-utils";

// How long we wait for the user to finish the browser sign-in before giving up.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface BrowserLoginResult {
	instanceUrl: string;
	accessToken: string;
}

/**
 * Interactive browser sign-in: a short-lived loopback server opens the browser,
 * the user picks a cluster and (already signed in there) copies a token from the
 * cluster's token page and pastes it back. The server never authenticates to the
 * cluster itself — no SAML round-trip, so no localhost redirect whitelisting.
 */
export function loginViaBrowser(
	defaultInstanceUrl = "",
): Promise<BrowserLoginResult> {
	return new Promise<BrowserLoginResult>((resolve, reject) => {
		let settled = false;
		// The cluster the user picked on the landing page (already sanitized).
		let chosenInstanceUrl = "";
		// The loopback origin (http://localhost:<port>), known once listening.
		let loopbackOrigin = "";
		// Per-launch CSRF secret required on every state-changing request;
		const nonce = randomUUID();

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
				nonce,
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
			finish(new Error(`Sign-in timed out after ${LOGIN_TIMEOUT_MS / 1000}s`));
		}, LOGIN_TIMEOUT_MS);

		server.on("error", (err) => finish(err));

		// Bind to an ephemeral port on loopback only.
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			loopbackOrigin = `http://localhost:${port}`;
			const landingUrl = `${loopbackOrigin}/`;

			console.error(
				"[ThoughtSpot MCP] Opening browser to choose a cluster and sign in ...",
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
	// Per-launch CSRF secret; see loginViaBrowser.
	nonce: string;
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

	// Reject non-loopback Host headers (DNS-rebinding could otherwise make an
	// attacker page same-origin and able to read the nonce).
	const hostName = (req.headers.host ?? "").split(":")[0].toLowerCase();
	if (hostName !== "localhost" && hostName !== "127.0.0.1") {
		res.writeHead(403);
		res.end("Forbidden");
		return;
	}

	// Landing page: pick / confirm the cluster URL.
	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(renderInstancePage(ctx.defaultInstanceUrl, "", ctx.nonce));
		return;
	}

	// Token page: link to the cluster token page and accept the pasted token.
	if (req.method === "GET" && url.pathname === "/manual") {
		if (!requireNonce(url, res, ctx)) {
			return;
		}
		const sanitized = sanitizeInstanceUrlOrRespond(req, res, ctx);
		if (!sanitized) {
			return;
		}
		ctx.setChosenInstanceUrl(sanitized);

		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(renderManualPage(sanitized, ctx.nonce));
		return;
	}

	if (req.method === "POST" && url.pathname === "/store-token") {
		// Origin + nonce checks: only our own pages may settle the flow, so no
		// other local page can race with a forged token. Both loopback hostnames
		// are allowed to match the Host guard above.
		const origin = req.headers.origin;
		if (origin && !isLoopbackOrigin(origin, ctx.loopbackOrigin)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
			return;
		}
		const body = await readBody(req);
		let token: string | null;
		let bodyNonce: unknown;
		try {
			const parsed = JSON.parse(body);
			bodyNonce = parsed?.nonce;
			token = extractToken(parsed);
		} catch {
			token = null;
		}
		if (bodyNonce !== ctx.nonce) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
			return;
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

// True when origin is our loopback server under either loopback hostname
// (the Host guard accepts both localhost and 127.0.0.1).
function isLoopbackOrigin(origin: string, loopbackOrigin: string): boolean {
	const port = loopbackOrigin.split(":")[2];
	return (
		origin === `http://localhost:${port}` ||
		origin === `http://127.0.0.1:${port}`
	);
}

// Requires the per-launch nonce on a state-changing GET; 403s on mismatch.
function requireNonce(
	url: URL,
	res: ServerResponse,
	ctx: RequestHandlerContext,
): boolean {
	if (url.searchParams.get("nonce") !== ctx.nonce) {
		res.writeHead(403);
		res.end("Forbidden");
		return false;
	}
	return true;
}

// Reads & sanitizes `instanceUrl`; on failure re-renders the landing page.
function sanitizeInstanceUrlOrRespond(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RequestHandlerContext,
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
				ctx.nonce,
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

// Best-effort browser open; the URL is also printed to stderr as fallback.
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

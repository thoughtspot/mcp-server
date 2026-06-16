/**
 * SpotterViz client.
 *
 * Aurora is reached through the same ThoughtSpot instance — nginx upstreams `/aurora/*` to the
 * Aurora MT host, rewrites the path (strips `/aurora`), and injects `X-Tenant-Host: $http_host`
 * itself — so we just call `<instanceUrl>/aurora/<path>` with the user's bearer token.
 */
import type { BachSession } from "../thoughtspot/types";
import type { AuroraSessionContext, AuroraSessionInitResult } from "./types";

export class SpotterVizClient {
	constructor(
		readonly instanceUrl: string,
		private readonly bearerToken: string,
		private readonly locale: string = "en-US",
	) {}

	/**
	 * Build the headers for an Aurora request. The User-Agent override is mandatory — the AWS
	 * WAF in front of the Aurora path blocks the default `Cloudflare-Workers` UA that Workers'
	 * fetch injects. Pass `token` for endpoints that require the Aurora session JWT (everything
	 * except `/aurora/init`).
	 */
	private buildHeaders(
		acceptMimeType: string,
		token?: string,
	): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"user-agent": "ThoughtSpot-ts-client",
			Accept: acceptMimeType,
			Authorization: `Bearer ${this.bearerToken}`,
		};
		if (token) {
			headers["X-Aurora-Session-Token"] = token;
		}
		return headers;
	}

	/**
	 * Open an Aurora session bound to an active BACH pinboard generation. Returns the Aurora
	 * session id and a short-lived JWT that subsequent `submitAuroraQuery` calls must echo back
	 * via the `X-Aurora-Session-Token` header.
	 */
	async createAuroraSession(
		bachSession: BachSession,
	): Promise<AuroraSessionInitResult> {
		const response = await fetch(`${this.instanceUrl}/aurora/init`, {
			method: "POST",
			headers: this.buildHeaders("application/json"),
			body: JSON.stringify({
				session_id: {
					transaction_id: bachSession.transactionId,
					generation_number: bachSession.generationNumber,
				},
				locale: this.locale,
				starter_prompts: [],
				tenant_flags: {
					enable_charting_skill: true,
				},
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`createAuroraSession failed (${response.status}): ${errorText}`,
			);
		}

		const data = (await response.json()) as {
			success?: boolean;
			message?: string;
			errors?: string[];
			jwt_token?: string;
			session_id?: string;
			liveboard_name?: string;
		};

		if (!data.success || !data.session_id || !data.jwt_token) {
			const errMsg =
				data.errors?.join("; ") ||
				data.message ||
				"Aurora /init returned an unsuccessful response";
			throw new Error(`createAuroraSession failed: ${errMsg}`);
		}

		return {
			auroraSessionId: data.session_id,
			jwtToken: data.jwt_token,
			liveboardName: data.liveboard_name,
		};
	}

	/**
	 * Submit a user message to an existing Aurora session and obtain an SSE stream of agent events.
	 * The returned Response carries an SSE body; the caller must drain it via `body.getReader()`
	 */
	async submitAuroraQuery(
		auroraCtx: AuroraSessionContext,
		message: string,
	): Promise<Response> {
		const response = await fetch(`${this.instanceUrl}/aurora/chat/stream`, {
			method: "POST",
			headers: this.buildHeaders("text/event-stream", auroraCtx.auroraJwtToken),
			body: JSON.stringify({
				message,
				session_id: {
					transaction_id: auroraCtx.transactionId,
					generation_number: auroraCtx.generationNumber,
				},
				liveboard_id: auroraCtx.liveboardId,
				stream: true,
				locale: this.locale,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`submitAuroraQuery failed (${response.status}): ${errorText}`,
			);
		}

		return response;
	}
}

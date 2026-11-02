// Shared helpers for the raw-fetch ThoughtSpot tools.

import type { ClientContext } from "./types";

export const ORG_HEADER = "x-thoughtspot-orgs";

// Fresh id sent as x-request-id so a call can be traced across systems.
export function generateRequestId(): string {
	return globalThis.crypto.randomUUID();
}

// Auth/content headers for the raw-fetch handlers, incl. the org header if set.
// `acceptLanguage`/`requestId` are opt-in: the Eureka endpoints 500 without a
// locale, and traced calls carry an x-request-id; the SDK-backed calls send
// neither.
function buildHeaders(
	token: string,
	orgId?: string,
	accept = "application/json",
	options: { requestId?: string; acceptLanguage?: string } = {},
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: accept,
		"user-agent": "ThoughtSpot-ts-client",
		Authorization: `Bearer ${token}`,
	};
	if (orgId) {
		headers[ORG_HEADER] = orgId;
	}
	if (options.acceptLanguage) {
		headers["accept-language"] = options.acceptLanguage;
	}
	if (options.requestId) {
		headers["x-request-id"] = options.requestId;
	}
	return headers;
}

export interface ApiRequestOptions {
	// Defaults to POST when `json` is set, else GET
	method?: string;
	// Serialized as the request body
	json?: unknown;
	accept?: string;
	requestId?: string;
	acceptLanguage?: string;
	// Set false to omit the org header even when ctx has an org
	scopeToOrg?: boolean;
	// Extra headers, e.g. Cookie
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

// Absolute URL for a path on the instance
export function apiUrl(ctx: ClientContext, path: string): string {
	return `${ctx.instanceUrl}${path}`;
}

// Auth/content headers derived from ctx, plus any extras in `opts.headers`
export function apiHeaders(
	ctx: ClientContext,
	opts: ApiRequestOptions = {},
): Record<string, string> {
	const { accept, requestId, acceptLanguage, scopeToOrg = true } = opts;
	return {
		...buildHeaders(ctx.token, scopeToOrg ? ctx.orgId : undefined, accept, {
			requestId,
			acceptLanguage,
		}),
		...opts.headers,
	};
}

// fetch() a path on the instance with ctx-derived auth/org headers
export function fetchApi(
	ctx: ClientContext,
	path: string,
	opts: ApiRequestOptions = {},
): Promise<Response> {
	const { json, signal } = opts;
	return fetch(apiUrl(ctx, path), {
		method: opts.method ?? (json === undefined ? "GET" : "POST"),
		headers: apiHeaders(ctx, opts),
		...(json !== undefined && { body: JSON.stringify(json) }),
		...(signal && { signal }),
	});
}

// POST JSON and return the parsed body; throws "<prefix> with status N: <text>"
// on a non-2xx so callers keep their existing error messages.
export async function postJson(
	ctx: ClientContext,
	path: string,
	json: unknown,
	errorPrefix: string,
	opts: ApiRequestOptions = {},
): Promise<any> {
	const response = await fetchApi(ctx, path, { ...opts, json });
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`${errorPrefix} with status ${response.status}: ${errorText}`,
		);
	}
	return await response.json();
}

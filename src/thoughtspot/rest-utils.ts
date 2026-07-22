// Shared helpers for the raw-fetch ThoughtSpot tools.

export const ORG_HEADER = "x-thoughtspot-orgs";

// Fresh id sent as x-request-id so a call can be traced across systems.
export function generateRequestId(): string {
	return globalThis.crypto.randomUUID();
}

// Auth/content headers for the raw-fetch handlers, incl. the org header if set.
// `acceptLanguage`/`requestId` are opt-in: the Eureka endpoints 500 without a
// locale, and traced calls carry an x-request-id; the SDK-backed calls send
// neither.
export function buildHeaders(
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

// POST JSON and return the parsed body; throws "<prefix> with status N: <text>"
// on a non-2xx so callers keep their existing error messages.
export async function postJson(
	url: string,
	headers: Record<string, string>,
	body: unknown,
	errorPrefix: string,
): Promise<any> {
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`${errorPrefix} with status ${response.status}: ${errorText}`,
		);
	}
	return await response.json();
}

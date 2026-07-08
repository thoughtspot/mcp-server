// Shared helpers for the gRPC-backed ThoughtSpot tools.

// Fresh id sent as x-request-id so a call can be traced across systems.
export function generateRequestId(): string {
	return globalThis.crypto.randomUUID();
}

// Standard headers for ThoughtSpot HTTP calls. accept-language is load-bearing:
// without it some endpoints fall back to locale "*" and 500. Pass `requestId`
// to add x-request-id, or `accept` to override the default JSON Accept.
export function buildTsHeaders(
	token: string,
	options: { requestId?: string; accept?: string } = {},
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: options.accept ?? "application/json",
		"accept-language": "en-US",
		"user-agent": "ThoughtSpot-ts-client",
		Authorization: `Bearer ${token}`,
	};
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

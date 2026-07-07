// Shared helpers for the gRPC-backed ThoughtSpot tools.

// Fresh id sent as x-request-id so a call can be traced across systems.
export function generateRequestId(): string {
	return globalThis.crypto.randomUUID();
}

import { vi } from "vitest";

export function makeRequest(name: string, args: Record<string, unknown>) {
	return {
		method: "tools/call" as const,
		params: { name, arguments: args },
	};
}

export function makeReader(chunks: string[]): ReadableStreamDefaultReader {
	let index = 0;
	return {
		read: vi.fn(async () => {
			if (index < chunks.length) {
				const value = new TextEncoder().encode(chunks[index++]);
				return { done: false, value };
			}
			return { done: true, value: undefined };
		}),
		cancel: vi.fn(),
		releaseLock: vi.fn(),
	} as unknown as ReadableStreamDefaultReader;
}

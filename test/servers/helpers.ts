export function makeRequest(name: string, args: Record<string, unknown>) {
	return {
		method: "tools/call" as const,
		params: { name, arguments: args },
	};
}

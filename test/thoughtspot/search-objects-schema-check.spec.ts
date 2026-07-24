import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySearchObjectsSchema } from "../../src/thoughtspot/search-objects/search-objects-schema-check";

const HOST = "https://test.thoughtspot.cloud";
const TOKEN = "test-token";

// Stub global fetch with a single resolved response body (or a rejection).
function stubFetch(outcome: { status?: number; body: unknown } | Error) {
	const fn = vi.fn();
	if (outcome instanceof Error) {
		fn.mockRejectedValueOnce(outcome);
	} else {
		fn.mockResolvedValueOnce({
			status: outcome.status ?? 200,
			json: async () => outcome.body,
		});
	}
	vi.stubGlobal("fetch", fn);
	return fn;
}

describe("verifySearchObjectsSchema", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("warns when the query fails GraphQL validation (schema drift)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		stubFetch({
			status: 400,
			body: {
				errors: [
					{
						message: 'Cannot query field "sageQuery" on type "Result".',
						extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
					},
				],
			},
		});

		const result = await verifySearchObjectsSchema(HOST, TOKEN);

		expect(result).toBe("drift");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toMatch(/schema mismatch/i);
		expect(warn.mock.calls[0][0]).toContain("sageQuery");
	});

	it("warns on a validation error detected by message pattern (no extensions)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		stubFetch({
			status: 200,
			body: { errors: [{ message: 'Unknown argument "foo" on field.' }] },
		});

		const result = await verifySearchObjectsSchema(HOST, TOKEN);

		expect(result).toBe("drift");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("returns 'ok' and logs an ok line (no warn) on a well-formed response", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		stubFetch({ body: { data: { queryRequest: { results: [] } } } });

		const result = await verifySearchObjectsSchema(HOST, TOKEN);

		expect(result).toBe("ok");
		expect(warn).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledTimes(1);
		expect(info.mock.calls[0][0]).toMatch(/schema check: ok after \d+ms/);
	});

	it("returns 'unknown' and logs an inconclusive line (no warn) on non-validation errors", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		stubFetch({
			status: 401,
			body: {
				errors: [
					{ message: "Unauthorized", extensions: { code: "UNAUTHENTICATED" } },
				],
			},
		});

		const result = await verifySearchObjectsSchema(HOST, TOKEN);

		expect(result).toBe("unknown");
		expect(warn).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledTimes(1);
		expect(info.mock.calls[0][0]).toMatch(/inconclusive after \d+ms/);
		expect(info.mock.calls[0][0]).toContain("Unauthorized");
	});

	it("returns 'unknown' (never throws) on a network failure", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		stubFetch(new Error("network down"));

		await expect(verifySearchObjectsSchema(HOST, TOKEN)).resolves.toBe(
			"unknown",
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("fires the GetEurekaResults operation at the prism endpoint", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const fn = stubFetch({ body: { data: {} } });

		await verifySearchObjectsSchema(HOST, TOKEN);

		const [url, opts] = fn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${HOST}/prism/?op=GetEurekaResults`);
		expect(JSON.parse(opts.body as string).operationName).toBe(
			"GetEurekaResults",
		);
	});
});

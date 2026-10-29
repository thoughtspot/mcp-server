import { createBearerAuthenticationConfig } from "@thoughtspot/rest-api-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThoughtSpotClient } from "../../../../src/services/clients/thoughtspot-client";

// Mock the ThoughtSpot REST API SDK
vi.mock("@thoughtspot/rest-api-sdk", () => ({
	createBearerAuthenticationConfig: vi.fn(),
	ThoughtSpotRestApi: vi.fn(),
}));

// Mock fetch
global.fetch = vi.fn();

describe("spotter-viz-client", () => {
	const mockInstanceUrl = "https://test.thoughtspot.com";
	const mockBearerToken = "test-token-123";

	let mockConfig: any;

	beforeEach(() => {
		vi.clearAllMocks();

		// Re-assign fetch as a fresh vi.fn() so mockResolvedValue/mockRejectedValue
		// are always available (vi.restoreAllMocks in afterEach would otherwise strip
		// the mock methods from the plain vi.fn() assigned at module load time).
		global.fetch = vi.fn();

		// Setup mock config
		mockConfig = {
			middleware: [],
		};

		(createBearerAuthenticationConfig as any).mockReturnValue(mockConfig);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("createBachPinboardSession", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("POSTs to /callosum/v1/bach/pinboard/ with a LOAD_PINBOARD request and a fresh client transaction id", async () => {
			const mockResponse = {
				status: { statusCode: "OK" },
				pinboardSession: {
					transactionId: "server-txn-1",
					generationNumber: 7,
				},
			};

			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			const result = await client.createBachPinboardSession({
				liveboardId: "lb-abc",
			});

			expect(fetch).toHaveBeenCalledWith(
				`${mockInstanceUrl}/callosum/v1/bach/pinboard/`,
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
						Accept: "application/json",
						"user-agent": "ThoughtSpot-ts-client",
						Authorization: `Bearer ${mockBearerToken}`,
					}),
				}),
			);

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.pinboardSession.transactionId).toEqual(expect.any(String));
			expect(body.pinboardSession.transactionId.length).toBeGreaterThan(0);
			expect(body.pinboardRequests).toEqual([
				{
					type: "LOAD_PINBOARD",
					loadPinboard: { savedPinboardId: "lb-abc" },
				},
			]);

			// Server-supplied ids, numeric generationNumber is coerced to string.
			expect(result).toEqual({
				transactionId: "server-txn-1",
				generationNumber: "7",
			});
		});

		it("keeps generationNumber as-is when the server returns a string", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					status: { statusCode: "OK" },
					pinboardSession: {
						transactionId: "t",
						generationNumber: "12",
					},
				}),
			});

			const result = await client.createBachPinboardSession({
				liveboardId: "lb-1",
			});
			expect(result.generationNumber).toBe("12");
		});

		it("throws with the body text on a non-ok HTTP response", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 500,
				text: vi.fn().mockResolvedValue("server exploded"),
			});

			await expect(
				client.createBachPinboardSession({ liveboardId: "lb-1" }),
			).rejects.toThrow(
				"createBachPinboardSession failed with status 500: server exploded",
			);
		});

		it("throws when the top-level status is non-OK, including the error message", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					status: {
						statusCode: "ERROR",
						errorMessage: "liveboard not found",
					},
				}),
			});

			await expect(
				client.createBachPinboardSession({ liveboardId: "lb-1" }),
			).rejects.toThrow(
				"createBachPinboardSession returned non-OK status ERROR: liveboard not found",
			);
		});

		it("falls back to per-request loadPinboard.status.errorMessage when top-level errorMessage is missing", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					status: { statusCode: "ERROR" },
					pinboardResponses: [
						{
							loadPinboard: {
								status: { errorMessage: "permission denied" },
							},
						},
					],
				}),
			});

			await expect(
				client.createBachPinboardSession({ liveboardId: "lb-1" }),
			).rejects.toThrow("permission denied");
		});

		it("throws when the response is missing session ids even with OK status", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					status: { statusCode: "OK" },
					// pinboardSession missing
				}),
			});

			await expect(
				client.createBachPinboardSession({ liveboardId: "lb-1" }),
			).rejects.toThrow(/missing session ids/);
		});

		it("propagates network errors from fetch", async () => {
			(fetch as any).mockRejectedValue(new Error("offline"));

			await expect(
				client.createBachPinboardSession({ liveboardId: "lb-1" }),
			).rejects.toThrow("offline");
		});
	});

	describe("createBachPinboardSession org scoping", () => {
		it("sends the org header when an org is active", async () => {
			const orgClient = getThoughtSpotClient(
				mockInstanceUrl,
				mockBearerToken,
				"101",
			) as any;
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					status: { statusCode: "OK" },
					pinboardSession: {
						transactionId: "server-txn-1",
						generationNumber: 7,
					},
				}),
			});

			await orgClient.createBachPinboardSession({ liveboardId: "lb-abc" });

			expect((fetch as any).mock.calls[0][1].headers).toMatchObject({
				"x-thoughtspot-orgs": "101",
				Authorization: `Bearer ${mockBearerToken}`,
			});
		});

		it("omits the org header when no org is active", async () => {
			const plainClient = getThoughtSpotClient(
				mockInstanceUrl,
				mockBearerToken,
			) as any;
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					status: { statusCode: "OK" },
					pinboardSession: {
						transactionId: "server-txn-1",
						generationNumber: 7,
					},
				}),
			});

			await plainClient.createBachPinboardSession({ liveboardId: "lb-abc" });

			expect(
				(fetch as any).mock.calls[0][1].headers["x-thoughtspot-orgs"],
			).toBeUndefined();
		});
	});

	describe("saveBachPinboard", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("POSTs to /callosum/v1/bach/pinboard/ with a SAVE_PINBOARD request and the supplied session ids", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ status: { statusCode: "OK" } }),
			});

			await client.saveBachPinboard({
				transactionId: "t-1",
				generationNumber: "5",
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.pinboardSession).toEqual({
				transactionId: "t-1",
				generationNumber: "5",
			});
			expect(body.pinboardRequests).toEqual([
				{ type: "SAVE_PINBOARD", savePinboard: {} },
			]);
		});

		it("still sends the standard auth and content headers", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ status: { statusCode: "OK" } }),
			});

			await client.saveBachPinboard({
				transactionId: "t-1",
				generationNumber: "5",
			});

			expect((fetch as any).mock.calls[0][1].headers).toMatchObject({
				"Content-Type": "application/json",
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${mockBearerToken}`,
			});
		});

		it("scopes the request to the active org when one is set", async () => {
			const orgClient = getThoughtSpotClient(
				mockInstanceUrl,
				mockBearerToken,
				"101",
			) as any;
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ status: { statusCode: "OK" } }),
			});

			await orgClient.saveBachPinboard({
				transactionId: "t-1",
				generationNumber: "5",
			});

			expect((fetch as any).mock.calls[0][1].headers).toMatchObject({
				"x-thoughtspot-orgs": "101",
			});
		});

		it("omits the org header when no org is active", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ status: { statusCode: "OK" } }),
			});

			await client.saveBachPinboard({
				transactionId: "t-1",
				generationNumber: "5",
			});

			expect(
				(fetch as any).mock.calls[0][1].headers["x-thoughtspot-orgs"],
			).toBeUndefined();
		});

		it("returns undefined on success", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ status: { statusCode: "OK" } }),
			});

			const result = await client.saveBachPinboard({
				transactionId: "t-1",
				generationNumber: "5",
			});
			expect(result).toBeUndefined();
		});

		it("does not report success when the body is null", async () => {
			// A null body used to skip the status check and return as a successful save, silently
			// losing the user's changes, since saving is what commits the edit session.
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(null),
			});

			await expect(
				client.saveBachPinboard({
					transactionId: "t-1",
					generationNumber: "5",
				}),
			).rejects.toThrow(/saveBachPinboard failed: non-object response body/);
		});

		it("throws with the body text on a non-ok HTTP response", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 503,
				text: vi.fn().mockResolvedValue("unavailable"),
			});

			await expect(
				client.saveBachPinboard({
					transactionId: "t-1",
					generationNumber: "5",
				}),
			).rejects.toThrow("saveBachPinboard failed with status 503: unavailable");
		});

		it("throws when the top-level status is non-OK", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					status: {
						statusCode: "ERROR",
						errorMessage: "save rejected",
					},
				}),
			});

			await expect(
				client.saveBachPinboard({
					transactionId: "t-1",
					generationNumber: "5",
				}),
			).rejects.toThrow(
				"saveBachPinboard returned non-OK status ERROR: save rejected",
			);
		});

		it("falls back to per-request savePinboard.status.errorMessage when present", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					status: { statusCode: "ERROR" },
					pinboardResponses: [
						{
							savePinboard: {
								status: { errorMessage: "save permission denied" },
							},
						},
					],
				}),
			});

			await expect(
				client.saveBachPinboard({
					transactionId: "t-1",
					generationNumber: "5",
				}),
			).rejects.toThrow("save permission denied");
		});
	});
});

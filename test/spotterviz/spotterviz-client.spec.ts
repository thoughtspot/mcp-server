import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotterVizClient } from "../../src/spotterviz/spotterviz-client";
import type {
	AuroraSessionContext,
	AuroraSessionInitResult,
} from "../../src/spotterviz/types";
import type { BachSession } from "../../src/thoughtspot/types";

const INSTANCE_URL = "https://test.thoughtspot.com";
const BEARER = "test-bearer-token";

const bachSession: BachSession = {
	transactionId: "txn-1",
	generationNumber: "7",
};

function makeJsonResponse(
	body: unknown,
	init: { status?: number; ok?: boolean } = {},
): Response {
	return {
		ok: init.ok ?? (init.status ?? 200) < 400,
		status: init.status ?? 200,
		json: vi.fn().mockResolvedValue(body),
		text: vi.fn().mockResolvedValue(typeof body === "string" ? body : ""),
	} as unknown as Response;
}

function makeErrorResponse(status: number, text: string): Response {
	return {
		ok: false,
		status,
		text: vi.fn().mockResolvedValue(text),
		json: vi.fn().mockResolvedValue({}),
	} as unknown as Response;
}

describe("SpotterVizClient", () => {
	beforeEach(() => {
		global.fetch = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("createAuroraSession", () => {
		it("POSTs to /aurora/init with the BACH session ids and parses the success response", async () => {
			const apiResponse = {
				success: true,
				session_id: "aurora-sess-1",
				jwt_token: "jwt-abc",
				liveboard_name: "Saved LB",
			};
			(fetch as any).mockResolvedValue(makeJsonResponse(apiResponse));

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			const result: AuroraSessionInitResult =
				await client.createAuroraSession(bachSession);

			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, options] = (fetch as any).mock.calls[0];
			expect(url).toBe(`${INSTANCE_URL}/aurora/init`);
			expect(options.method).toBe("POST");

			const body = JSON.parse(options.body);
			expect(body.session_id).toEqual({
				transaction_id: bachSession.transactionId,
				generation_number: bachSession.generationNumber,
			});
			expect(body.locale).toBe("en-US");
			expect(body.starter_prompts).toEqual([]);
			expect(body.tenant_flags).toEqual({ enable_charting_skill: true });

			expect(result).toEqual({
				auroraSessionId: "aurora-sess-1",
				jwtToken: "jwt-abc",
				liveboardName: "Saved LB",
			});
		});

		it("uses the configured locale", async () => {
			(fetch as any).mockResolvedValue(
				makeJsonResponse({
					success: true,
					session_id: "s",
					jwt_token: "j",
				}),
			);

			const client = new SpotterVizClient(INSTANCE_URL, BEARER, "fr-FR");
			await client.createAuroraSession(bachSession);

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.locale).toBe("fr-FR");
		});

		it("sends Authorization, user-agent override, and JSON Accept", async () => {
			(fetch as any).mockResolvedValue(
				makeJsonResponse({
					success: true,
					session_id: "s",
					jwt_token: "j",
				}),
			);

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			await client.createAuroraSession(bachSession);

			const headers = (fetch as any).mock.calls[0][1].headers as Record<
				string,
				string
			>;
			expect(headers.Authorization).toBe(`Bearer ${BEARER}`);
			expect(headers["user-agent"]).toBe("ThoughtSpot-ts-client");
			expect(headers.Accept).toBe("application/json");
			expect(headers["Content-Type"]).toBe("application/json");
			// /init must not carry the session token header — only later calls do.
			expect(headers["X-Aurora-Session-Token"]).toBeUndefined();
		});

		it("throws with status + body on non-ok HTTP response", async () => {
			(fetch as any).mockResolvedValue(makeErrorResponse(502, "upstream down"));

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			await expect(client.createAuroraSession(bachSession)).rejects.toThrow(
				"createAuroraSession failed (502): upstream down",
			);
		});

		it("throws if the payload is missing session_id or jwt_token", async () => {
			(fetch as any).mockResolvedValue(
				makeJsonResponse({ success: true, jwt_token: "j" }),
			);

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			await expect(client.createAuroraSession(bachSession)).rejects.toThrow(
				/createAuroraSession failed/,
			);
		});

		it("throws and surfaces error list when success=false", async () => {
			(fetch as any).mockResolvedValue(
				makeJsonResponse({
					success: false,
					errors: ["boom-1", "boom-2"],
				}),
			);

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			await expect(client.createAuroraSession(bachSession)).rejects.toThrow(
				"createAuroraSession failed: boom-1; boom-2",
			);
		});

		it("falls back to message when errors array is absent", async () => {
			(fetch as any).mockResolvedValue(
				makeJsonResponse({ success: false, message: "no good" }),
			);

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			await expect(client.createAuroraSession(bachSession)).rejects.toThrow(
				"createAuroraSession failed: no good",
			);
		});

		it("returns undefined liveboardName when the response omits it", async () => {
			(fetch as any).mockResolvedValue(
				makeJsonResponse({
					success: true,
					session_id: "s",
					jwt_token: "j",
				}),
			);

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			const result = await client.createAuroraSession(bachSession);
			expect(result.liveboardName).toBeUndefined();
		});
	});

	describe("submitAuroraQuery", () => {
		const auroraCtx: AuroraSessionContext = {
			auroraSessionId: "aurora-sess-1",
			auroraJwtToken: "jwt-xyz",
			transactionId: "txn-9",
			generationNumber: "3",
			liveboardId: "lb-1",
		};

		it("POSTs to /aurora/chat/stream with the message and session ids", async () => {
			const sseResponse = makeJsonResponse({}, { ok: true, status: 200 });
			(fetch as any).mockResolvedValue(sseResponse);

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			const result = await client.submitAuroraQuery(
				auroraCtx,
				"How is revenue?",
			);

			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, options] = (fetch as any).mock.calls[0];
			expect(url).toBe(`${INSTANCE_URL}/aurora/chat/stream`);
			expect(options.method).toBe("POST");

			const body = JSON.parse(options.body);
			expect(body.message).toBe("How is revenue?");
			expect(body.session_id).toEqual({
				transaction_id: "txn-9",
				generation_number: "3",
			});
			expect(body.liveboard_id).toBe("lb-1");
			expect(body.stream).toBe(true);
			expect(body.locale).toBe("en-US");

			expect(result).toBe(sseResponse);
		});

		it("sends the SSE Accept header and echoes the Aurora session JWT", async () => {
			(fetch as any).mockResolvedValue(makeJsonResponse({}));

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			await client.submitAuroraQuery(auroraCtx, "msg");

			const headers = (fetch as any).mock.calls[0][1].headers as Record<
				string,
				string
			>;
			expect(headers.Accept).toBe("text/event-stream");
			expect(headers["X-Aurora-Session-Token"]).toBe("jwt-xyz");
			expect(headers.Authorization).toBe(`Bearer ${BEARER}`);
			expect(headers["user-agent"]).toBe("ThoughtSpot-ts-client");
		});

		it("throws with status + body on non-ok HTTP response", async () => {
			(fetch as any).mockResolvedValue(makeErrorResponse(401, "no auth"));

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			await expect(client.submitAuroraQuery(auroraCtx, "msg")).rejects.toThrow(
				"submitAuroraQuery failed (401): no auth",
			);
		});

		it("propagates network errors from fetch", async () => {
			(fetch as any).mockRejectedValue(new Error("offline"));

			const client = new SpotterVizClient(INSTANCE_URL, BEARER);
			await expect(client.submitAuroraQuery(auroraCtx, "msg")).rejects.toThrow(
				"offline",
			);
		});
	});
});

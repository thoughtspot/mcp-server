import { describe, expect, it, vi } from "vitest";
import {
	MIN_TOKEN_VALIDITY_MS,
	withExpiredTokenGuard,
} from "../src/store-token-guard";

const ORIGIN = "https://mcp.example.com";
const VALID_TOKEN = {
	token: "access-token",
	refreshToken: "refresh-token",
	tokenCreatedTime: 1000,
	tokenExpiryDuration: 4102444800000,
};

function storeTokenRequest(body: unknown, path = "/store-token") {
	return new Request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function storeTokenBody(data: Record<string, unknown>) {
	return {
		token: { data },
		oauthReqInfo: { clientId: "client-1" },
		instanceUrl: "https://acme.thoughtspot.cloud",
	};
}

function guarded() {
	const handler = vi.fn(async () => new Response("ok", { status: 200 }));
	return { handler, fetch: withExpiredTokenGuard(handler) };
}

const ctx = {} as ExecutionContext;

describe("withExpiredTokenGuard", () => {
	it("passes a valid token through to the handler", async () => {
		const { handler, fetch } = guarded();
		const response = await fetch(
			storeTokenRequest(storeTokenBody(VALID_TOKEN)),
			{},
			ctx,
		);

		expect(response.status).toBe(200);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it.each([
		["an expired token", { ...VALID_TOKEN, tokenExpiryDuration: 2000 }],
		[
			"a token expiring within 12h",
			{
				...VALID_TOKEN,
				tokenExpiryDuration: Date.now() + MIN_TOKEN_VALIDITY_MS - 60_000,
			},
		],
		[
			"a token without a refresh token",
			{ ...VALID_TOKEN, refreshToken: undefined },
		],
	])("returns 401 for %s", async (_, data) => {
		const { handler, fetch } = guarded();
		const response = await fetch(
			storeTokenRequest(storeTokenBody(data)),
			{},
			ctx,
		);

		expect(response.status).toBe(401);
		expect(handler).not.toHaveBeenCalled();
	});

	it("accepts a token with at least 12h of validity left", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		try {
			const { handler, fetch } = guarded();
			await fetch(
				storeTokenRequest(
					storeTokenBody({
						...VALID_TOKEN,
						tokenExpiryDuration: Date.now() + MIN_TOKEN_VALIDITY_MS,
					}),
				),
				{},
				ctx,
			);

			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["other paths", storeTokenRequest(storeTokenBody({}), "/authorize")],
		["unparseable bodies", storeTokenRequest("not json")],
		["bodies without a token", storeTokenRequest({ oauthReqInfo: {} })],
	])("leaves %s to the handler", async (_, request) => {
		const { handler, fetch } = guarded();
		await fetch(request, {}, ctx);

		expect(handler).toHaveBeenCalledTimes(1);
	});
});

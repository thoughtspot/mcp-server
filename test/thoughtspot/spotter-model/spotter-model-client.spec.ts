import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSpotterModel } from "../../../src/thoughtspot/spotter-model/spotter-model-client";

const INSTANCE_URL = "https://test.thoughtspot.com";
const TOKEN = "test-token-123";

// Register the handlers on a bare object — no SDK involved.
function makeClient(orgId?: string): any {
	const client: any = {};
	addSpotterModel(client, INSTANCE_URL, TOKEN, orgId);
	return client;
}

// The last fetch call's url / parsed JSON body / headers.
function lastCall() {
	const [url, init] = (global.fetch as any).mock.calls.at(-1);
	return {
		url: url as string,
		init: init as RequestInit,
		body: JSON.parse((init as any).body),
		headers: (init as any).headers as Record<string, string>,
	};
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status });
}

describe("spotter-model client", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers every handler", () => {
		const client = makeClient();
		expect(typeof client.mintSessionCookie).toBe("function");
		expect(typeof client.createModelSession).toBe("function");
		expect(typeof client.sendModelMessageStreaming).toBe("function");
		expect(typeof client.saveModel).toBe("function");
		expect(typeof client.fetchWorksheetModel).toBe("function");
	});

	describe("createModelSession", () => {
		const initResponse = {
			conversation_id: "conv-1",
			transaction_id: "txn-1",
			generation_no: 1,
		};

		it("posts connectionGuid to model/init for a new model", async () => {
			(global.fetch as any).mockResolvedValue(jsonResponse(initResponse));
			const client = makeClient();

			const result = await client.createModelSession({
				connectionIdentifier: "connection-guid",
			});

			expect(lastCall().url).toBe(
				`${INSTANCE_URL}/lumos/api/v2/conversation/model/init`,
			);
			expect(lastCall().body).toEqual({ connectionGuid: "connection-guid" });
			expect(result).toEqual(initResponse);
		});

		it("posts modelGuid alone when editing an existing model", async () => {
			(global.fetch as any).mockResolvedValue(jsonResponse(initResponse));
			const client = makeClient();

			await client.createModelSession({
				connectionIdentifier: "connection-guid",
				modelIdentifier: "model-guid",
			});

			// modelGuid wins upstream, and an unknown/extra key would be silently dropped,
			// so only the one that applies is sent.
			expect(lastCall().body).toEqual({ modelGuid: "model-guid" });
		});

		it("accepts a camelCase response", async () => {
			(global.fetch as any).mockResolvedValue(
				jsonResponse({
					conversationId: "conv-2",
					transactionId: "txn-2",
					generationNo: 3,
				}),
			);
			const client = makeClient();

			expect(
				await client.createModelSession({ connectionIdentifier: "c" }),
			).toEqual({
				conversation_id: "conv-2",
				transaction_id: "txn-2",
				generation_no: 3,
			});
		});

		it("throws with the upstream status and body on failure", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response("identifier is required", { status: 400 }),
			);
			const client = makeClient();

			await expect(
				client.createModelSession({ connectionIdentifier: "c" }),
			).rejects.toThrow(
				"createModelSession failed with status 400: identifier is required",
			);
		});
	});

	describe("sendModelMessageStreaming", () => {
		const params = {
			conversation_identifier: "conv 1/with-slash",
			transaction_id: "txn-1",
			generation_no: 2,
			message: "add a revenue formula",
		};

		it("mirrors the UI stream request", async () => {
			const upstream = new Response("data: {}\n\n", { status: 200 });
			(global.fetch as any).mockResolvedValue(upstream);
			const client = makeClient();

			const result = await client.sendModelMessageStreaming(params);

			expect(result).toBe(upstream);
			expect(lastCall().url).toBe(
				`${INSTANCE_URL}/lumos/api/v2/conversation/chat/conv%201%2Fwith-slash/stream`,
			);
			expect(lastCall().body).toEqual({
				transactionId: "txn-1",
				generationNo: 2,
				pinnedClientGenerationNumber: [],
				message: "add a revenue formula",
				choice: null,
				isRestoreRequest: false,
			});
			expect(lastCall().headers.Accept).toBe("text/event-stream");
			expect(lastCall().headers.Cookie).toBeUndefined();
		});

		it("sends the pinned generation set, the choice answer and the session cookie", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response("", { status: 200 }),
			);
			const client = makeClient();

			await client.sendModelMessageStreaming({
				...params,
				gen_no_working_set: [2, 3],
				session_cookie: "JSESSIONID=abc",
				choice: { title: "pick one" },
			});

			expect(lastCall().body.pinnedClientGenerationNumber).toEqual([2, 3]);
			expect(lastCall().body.choice).toEqual({ title: "pick one" });
			expect(lastCall().headers.Cookie).toBe("JSESSIONID=abc");
		});

		it("throws with the upstream status and body on failure", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response("stream rejected", { status: 500 }),
			);
			const client = makeClient();

			await expect(client.sendModelMessageStreaming(params)).rejects.toThrow(
				"sendModelMessageStreaming failed with status 500: stream rejected",
			);
		});
	});

	describe("saveModel", () => {
		const saved = {
			data: {
				Worksheet__operation: {
					id: { sessionId: "txn-1", genNo: 4 },
					worksheetHeader: { guid: "model-guid", displayName: "Sales" },
				},
			},
		};

		it("renames and saves when a name is given", async () => {
			(global.fetch as any).mockResolvedValue(jsonResponse(saved));
			const client = makeClient();

			const result = await client.saveModel({
				transaction_id: "txn-1",
				generation_no: 4,
				gen_no_working_set: [2, 3, 4],
				name: "Sales",
				description: "Sales model",
			});

			expect(lastCall().url).toBe(
				`${INSTANCE_URL}/prism/?op=WorksheetOperation`,
			);
			expect(lastCall().body.variables.session).toEqual({
				sessionId: "txn-1",
				genNo: 4,
				genNoWorkingSet: [2, 3, 4],
			});
			expect(
				lastCall().body.variables.baseRequests.map((r: any) => r.requestType),
			).toEqual([
				"UPDATE_WORKSHEET_NAME_DESCRIPTION_REQUEST",
				"SAVE_WORKSHEET_REQUEST",
			]);
			expect(
				lastCall().body.variables.baseRequests[0]
					.updateWorksheetNameDescriptionTransform,
			).toEqual({ name: "Sales", description: "Sales model" });
			expect(result).toEqual({
				model_identifier: "model-guid",
				url: `${INSTANCE_URL}/#/data/tables/model-guid`,
			});
		});

		it("skips the rename request entirely when no name is given", async () => {
			(global.fetch as any).mockResolvedValue(jsonResponse(saved));
			const client = makeClient();

			await client.saveModel({ transaction_id: "txn-1", generation_no: 4 });

			// An edit-save with no name must preserve the model's existing name AND description.
			expect(
				lastCall().body.variables.baseRequests.map((r: any) => r.requestType),
			).toEqual(["SAVE_WORKSHEET_REQUEST"]);
		});

		it("defaults an omitted description to an empty string", async () => {
			(global.fetch as any).mockResolvedValue(jsonResponse(saved));
			const client = makeClient();

			await client.saveModel({
				transaction_id: "txn-1",
				generation_no: 4,
				name: "Sales",
			});

			expect(
				lastCall().body.variables.baseRequests[0]
					.updateWorksheetNameDescriptionTransform.description,
			).toBe("");
		});

		it("coerces string generations and falls back to the current generation", async () => {
			(global.fetch as any).mockResolvedValue(jsonResponse(saved));
			const client = makeClient();

			await client.saveModel({
				transaction_id: "txn-1",
				generation_no: "4" as any,
				gen_no_working_set: [],
			});

			// genNo must be a GraphQL Int, and an empty working set would fail the save.
			expect(lastCall().body.variables.session).toEqual({
				sessionId: "txn-1",
				genNo: 4,
				genNoWorkingSet: [4],
			});
		});

		it("throws on a GraphQL error carried by a 200", async () => {
			(global.fetch as any).mockResolvedValue(
				jsonResponse({ errors: [{ message: "code 13130" }] }),
			);
			const client = makeClient();

			await expect(
				client.saveModel({ transaction_id: "txn-1", generation_no: 1 }),
			).rejects.toThrow("saveModel GraphQL error");
		});

		it("throws when the response carries no worksheet guid", async () => {
			(global.fetch as any).mockResolvedValue(
				jsonResponse({ data: { Worksheet__operation: {} } }),
			);
			const client = makeClient();

			await expect(
				client.saveModel({ transaction_id: "txn-1", generation_no: 1 }),
			).rejects.toThrow("saveModel returned no worksheet guid");
		});

		it("throws with the upstream status and body on failure", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response("nope", { status: 403 }),
			);
			const client = makeClient();

			await expect(
				client.saveModel({ transaction_id: "txn-1", generation_no: 1 }),
			).rejects.toThrow("saveModel failed with status 403: nope");
		});

		it("scopes the request to the active org", async () => {
			(global.fetch as any).mockResolvedValue(jsonResponse(saved));
			const client = makeClient("org-42");

			await client.saveModel({ transaction_id: "txn-1", generation_no: 1 });

			expect(lastCall().headers["x-thoughtspot-orgs"]).toBe("org-42");
		});
	});

	describe("fetchWorksheetModel", () => {
		it("requests the materialized model", async () => {
			const payload = {
				data: { Worksheet__operation: { worksheetModel: { schemaJoins: [] } } },
			};
			(global.fetch as any).mockResolvedValue(jsonResponse(payload));
			const client = makeClient();

			const result = await client.fetchWorksheetModel({
				session_identifier: "txn-1",
				generation_number: "3" as any,
			});

			expect(lastCall().body.variables.baseRequests).toEqual([
				{ requestType: "FETCH_WORKSHEET_MODEL_REQUEST" },
			]);
			expect(lastCall().body.variables.session).toEqual({
				sessionId: "txn-1",
				genNo: 3,
				genNoWorkingSet: [3],
			});
			expect(result).toEqual(payload);
		});

		it("throws with the upstream status and body on failure", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response("bad session", { status: 500 }),
			);
			const client = makeClient();

			await expect(
				client.fetchWorksheetModel({
					session_identifier: "txn-1",
					generation_number: 1,
				}),
			).rejects.toThrow(
				"fetchWorksheetModel failed with status 500: bad session",
			);
		});
	});

	describe("mintSessionCookie", () => {
		// Only .ok and .headers are touched, so a minimal stand-in keeps the cookie
		// plumbing deterministic across runtimes.
		const cookieResponse = (opts: {
			ok: boolean;
			setCookies?: string[];
			single?: string | null;
		}) => ({
			ok: opts.ok,
			status: opts.ok ? 200 : 401,
			headers: {
				getSetCookie: opts.setCookies ? () => opts.setCookies : undefined,
				get: () => opts.single ?? null,
			},
		});

		it("folds Set-Cookie values into a Cookie header, dropping attributes", async () => {
			(global.fetch as any).mockResolvedValue(
				cookieResponse({
					ok: true,
					setCookies: [
						"JSESSIONID=abc; Path=/; HttpOnly",
						"clientId=xyz; Secure",
					],
				}),
			);
			const client = makeClient();

			expect(await client.mintSessionCookie()).toBe(
				"JSESSIONID=abc; clientId=xyz",
			);
			expect(lastCall().url).toBe(
				`${INSTANCE_URL}/api/rest/2.0/auth/session/login`,
			);
		});

		it("falls back to a single set-cookie header", async () => {
			(global.fetch as any).mockResolvedValue(
				cookieResponse({ ok: true, single: "JSESSIONID=only; Path=/" }),
			);
			const client = makeClient();

			expect(await client.mintSessionCookie()).toBe("JSESSIONID=only");
		});

		it("returns null when login fails", async () => {
			(global.fetch as any).mockResolvedValue(
				cookieResponse({ ok: false, setCookies: ["JSESSIONID=abc"] }),
			);
			const client = makeClient();

			expect(await client.mintSessionCookie()).toBeNull();
		});

		it("returns null when no usable cookie comes back", async () => {
			(global.fetch as any).mockResolvedValue(
				cookieResponse({ ok: true, setCookies: ["no-equals-sign"] }),
			);
			const client = makeClient();

			expect(await client.mintSessionCookie()).toBeNull();
		});
	});
});

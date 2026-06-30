import { connect } from "mcp-testing-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCPServer } from "../../src/servers/mcp-server";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";
import { ThoughtSpotApiError } from "../../src/thoughtspot/types";

vi.mock("../../src/metrics/mixpanel/mixpanel", () => ({
	MixpanelTracker: vi.fn().mockImplementation(() => ({ track: vi.fn() })),
}));

/**
 * Tests for the org tools (list_orgs / switch_org) and their supporting
 * machinery: the OAuth + orgs-enabled gate, the shared active-org store, and
 * org-scoped token minting.
 */

// A fake CONVERSATION_STORAGE_OBJECT namespace that emulates the active-org DO.
// Stores active-org values in a Map keyed by the DO instance name, so reads and
// writes from any server instance sharing the same storage-key hash see the same
// value (mirroring the real shared store).
// `store` maps DO instance name -> { activeOrgId, orgToken } (mirrors the real
// shared active-org record). Setting the active org clears the token; a separate
// active-org-token POST sets it.
function makeStorageNamespace(
	store: Map<string, { activeOrgId?: string; orgToken?: string }>,
	tokenStore?: Map<string, any>,
	touchLog?: string[],
) {
	return {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			fetch: async (url: string, init?: RequestInit) => {
				const op = new URL(url).pathname.split("/").pop();
				const rec = store.get(id.name) ?? {};
				if (op === "active-org" && (init?.method ?? "GET") === "GET") {
					return Response.json({
						activeOrgId: rec.activeOrgId ?? null,
						orgToken: rec.orgToken ?? null,
					});
				}
				if (op === "active-org" && init?.method === "POST") {
					const body = JSON.parse(String(init?.body)) as {
						activeOrgId: string;
						orgToken?: string | null;
					};
					// Setting the active org clears the token unless one is provided.
					store.set(id.name, {
						activeOrgId: body.activeOrgId,
						orgToken: body.orgToken ?? undefined,
					});
					return Response.json({ ok: true });
				}
				if (op === "active-org-token" && init?.method === "POST") {
					const body = JSON.parse(String(init?.body)) as { orgToken: string };
					store.set(id.name, { ...rec, orgToken: body.orgToken });
					return Response.json({ ok: true });
				}
				if (op === "token-store" && (init?.method ?? "GET") === "GET") {
					const s = tokenStore?.get(id.name);
					return Response.json({
						accessToken: s?.accessToken ?? null,
						expiresAt: s?.expiresAt ?? null,
					});
				}
				if (op === "token-store" && init?.method === "POST") {
					tokenStore?.set(id.name, JSON.parse(String(init?.body)));
					return Response.json({ ok: true });
				}
				if (op === "touch" && init?.method === "POST") {
					touchLog?.push(id.name);
					return Response.json({ ok: true });
				}
				return new Response("Not Found", { status: 404 });
			},
		}),
	};
}

type SessionInfoOverrides = {
	orgsEnabled?: boolean;
	currentOrgId?: string;
};

function makeClientMock(opts: {
	session?: SessionInfoOverrides;
	orgs?: Array<{ id: number; name: string; status: string }>;
	fetchOrgBearerToken?: ReturnType<typeof vi.fn>;
	searchOrgs?: ReturnType<typeof vi.fn>;
	listOrgs?: ReturnType<typeof vi.fn>;
	validateConnection?: ReturnType<typeof vi.fn>;
}) {
	const orgsConfiguration =
		opts.session?.orgsEnabled === undefined
			? undefined
			: { enabled: opts.session.orgsEnabled };
	return {
		getSessionInfo: vi.fn().mockResolvedValue({
			clusterId: "test-cluster-123",
			clusterName: "test-cluster",
			releaseVersion: "10.13.0.cl-110",
			userGUID: "test-user-123",
			userName: "test-user",
			currentOrgId: opts.session?.currentOrgId ?? "0",
			privileges: [],
			configInfo: {
				mixpanelConfig: {
					devSdkKey: "k",
					prodSdkKey: "k",
					production: false,
				},
				selfClusterName: "test-cluster",
				selfClusterId: "test-cluster-123",
				enableSpotterDataSourceDiscovery: false,
				orgsConfiguration,
			},
		}),
		searchOrgs:
			opts.searchOrgs ??
			vi.fn().mockResolvedValue(
				opts.orgs ?? [
					{ id: 0, name: "Primary", status: "ACTIVE", description: "Primary" },
					{ id: 101, name: "DataPlatform", status: "ACTIVE" },
				],
			),
		// list_orgs uses the user-scoped client.listOrgs() (v1 session/orgs),
		// returning already-mapped Org[] ({ id, name, description }).
		listOrgs:
			opts.listOrgs ??
			vi.fn().mockResolvedValue(
				opts.orgs ?? [
					{ id: 0, name: "Primary", description: "Primary" },
					{ id: 101, name: "DataPlatform" },
				],
			),
		fetchOrgBearerToken:
			opts.fetchOrgBearerToken ?? vi.fn().mockResolvedValue("org-scoped-token"),
		validateConnection:
			opts.validateConnection ?? vi.fn().mockResolvedValue(true),
		instanceUrl: "https://test.thoughtspot.cloud",
	} as any;
}

function makeServer(opts: {
	authMode?: string;
	session?: SessionInfoOverrides;
	orgs?: Array<{ id: number; name: string; status: string }>;
	store?: Map<string, { activeOrgId?: string; orgToken?: string }>;
	tokenStore?: Map<string, any>;
	fetchOrgBearerToken?: ReturnType<typeof vi.fn>;
	searchOrgs?: ReturnType<typeof vi.fn>;
	listOrgs?: ReturnType<typeof vi.fn>;
	validateConnection?: ReturnType<typeof vi.fn>;
	touchLog?: string[];
	apiVersion?: string;
}) {
	vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue(
		makeClientMock(opts),
	);
	const store =
		opts.store ??
		new Map<string, { activeOrgId?: string; orgToken?: string }>();
	const tokenStore = opts.tokenStore ?? new Map<string, any>();
	// The token/org methods now route to USER_TOKEN_OBJECT; conversation methods
	// to CONVERSATION_STORAGE_OBJECT. The fake namespace dispatches by path, so a
	// single shared instance backs both bindings in tests.
	const namespace = makeStorageNamespace(store, tokenStore, opts.touchLog);
	const env = {
		CONVERSATION_STORAGE_OBJECT: namespace,
		USER_TOKEN_OBJECT: namespace,
	} as any;
	const props = {
		instanceUrl: "https://test.thoughtspot.cloud",
		accessToken: "global-token",
		refreshToken: "refresh-token",
		tokenExpiryDuration: 1893456000000,
		authMode: opts.authMode,
		apiVersion: opts.apiVersion ?? "latest",
		clientName: {
			clientId: "c",
			clientName: "c",
			registrationDate: 0,
		},
	};
	return { server: new MCPServer({ props, env }), store, tokenStore };
}

describe("MCP Server org tools", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("tool visibility gate (OAuth AND orgs enabled)", () => {
		it("lists org tools when OAuth and orgs enabled", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).toContain("list_orgs");
			expect(names).toContain("switch_org");
		});

		it("hides org tools when orgs are not enabled on the cluster", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: false },
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).not.toContain("list_orgs");
			expect(names).not.toContain("switch_org");
		});

		it("hides org tools for non-OAuth (bearer) connections even if orgs enabled", async () => {
			const { server } = makeServer({
				authMode: "bearer",
				session: { orgsEnabled: true },
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).not.toContain("list_orgs");
			expect(names).not.toContain("switch_org");
		});

		it("hides org tools on the v1 (backwards-compatibility) API surface, even with OAuth + orgs enabled", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				apiVersion: "backwards-compatibility-default",
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).not.toContain("list_orgs");
			expect(names).not.toContain("switch_org");
		});

		it("does NOT apply the org overlay (no active org / no mint) on a v1 session", async () => {
			const mint = vi.fn().mockResolvedValue("org-scoped-token");
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				apiVersion: "backwards-compatibility-default",
				fetchOrgBearerToken: mint,
				store,
			});
			await server.init();
			// v1 session: no active org defaulted, no org token minted.
			expect(mint).not.toHaveBeenCalled();
			expect([...store.values()].some((r) => r.activeOrgId)).toBe(false);
		});

		it("fails closed: hides org tools when orgs-enabled flag is absent", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: {}, // orgsConfiguration undefined
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).not.toContain("list_orgs");
			expect(names).not.toContain("switch_org");
		});
	});

	describe("non-org cluster (orgs disabled): no org overlay on connect", () => {
		it("does NOT mint an org token or set an active org when orgs are disabled", async () => {
			const mint = vi.fn().mockResolvedValue("org-scoped-token");
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: false, currentOrgId: "0" },
				store,
				fetchOrgBearerToken: mint,
			});
			await server.init();
			// postInit must skip the org overlay entirely: no mint, no active-org write,
			// and getActiveOrgId stays undefined (so no x-thoughtspot-orgs header).
			expect(mint).not.toHaveBeenCalled();
			expect(store.size).toBe(0);
			expect((server as any).getActiveOrgId()).toBeUndefined();
		});

		it("still seeds the cluster-wide keep-warm token when orgs are disabled", async () => {
			const tokenStore = new Map<string, any>();
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: false },
				tokenStore,
			});
			await server.init();
			// The global token is org-agnostic and must still be seeded/kept warm.
			const seeded = [...tokenStore.values()][0];
			expect(seeded?.accessToken).toBe("global-token");
		});
	});

	describe("list_orgs", () => {
		it("returns ACTIVE orgs and marks the current org active when none switched", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
			});
			await server.init();
			const { callTool } = connect(server);
			const res = await callTool("list_orgs", {});
			const data = JSON.parse(res.content[0].text);
			expect(data.orgs.map((o: any) => o.id)).toEqual([0, 101]);
			// On first connect the active org defaults to the session's current org
			// (currentOrgId "0"), so that org is marked active.
			expect(data.orgs.find((o: any) => o.is_active).id).toBe(0);
		});

		it("uses the GLOBAL token with no org header (not the org-scoped token)", async () => {
			// Listing orgs is a cluster-level operation: it must authenticate with the
			// global token and send NO x-thoughtspot-orgs header, even when an org is
			// active. An org-scoped token can fail/under-report when enumerating orgs.
			// (Driven directly rather than via connect().callTool, which deadlocks in
			// mcp-testing-kit when a switch_org and a second tool call share a test.)
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
			});
			await server.init();
			const s = server as unknown as {
				setActiveOrg: (orgId: string) => Promise<void>;
				ensureOrgToken: (orgId: string) => Promise<string>;
				callListOrgs: (recorder: any) => Promise<any>;
			};
			// Put an org token in play (the thing list_orgs must NOT use).
			await s.setActiveOrg("101");
			await s.ensureOrgToken("101");

			const spy = vi.mocked(thoughtspotClient.getThoughtSpotClient);
			spy.mockClear();
			await s.callListOrgs(undefined);

			// Every getThoughtSpotClient call made while serving list_orgs must use the
			// global token ("global-token") and pass orgId undefined (no org header).
			expect(spy).toHaveBeenCalled();
			for (const call of spy.mock.calls) {
				expect(call[1]).toBe("global-token"); // bearerToken arg
				expect(call[2]).toBeUndefined(); // orgId arg
			}
		});

		it("rejects direct invocation when org tools are unavailable", async () => {
			const { server } = makeServer({
				authMode: "bearer",
				session: { orgsEnabled: true },
			});
			await server.init();
			const { callTool } = connect(server);
			const res = await callTool("list_orgs", {});
			expect(res.isError).toBe(true);
		});
	});

	describe("switch_org", () => {
		it("mints an org token and persists the active org to the shared store", async () => {
			const { server, store } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
			});
			await server.init();

			const switchRes = await connect(server).callTool("switch_org", {
				org_id: 101,
			});
			const switchData = JSON.parse(switchRes.content[0].text);
			expect(switchData.success).toBe(true);
			expect(switchData.active_org_id).toBe(101);
			// Persisted to the shared store: active org id AND the minted org token
			// (so other fanned-out sessions reuse it instead of re-minting).
			const rec = [...store.values()][0];
			expect(rec.activeOrgId).toBe("101");
			expect(rec.orgToken).toBe("org-scoped-token");
		});

		it("returns 'not accessible' when minting the org token 401s", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				fetchOrgBearerToken: vi
					.fn()
					.mockRejectedValue(
						new Error("fetchOrgBearerToken failed with status 401: nope"),
					),
			});
			await server.init();
			const { callTool } = connect(server);
			const res = await callTool("switch_org", { org_id: 999 });
			expect(res.isError).toBe(true);
			expect(res.content[0].text).toMatch(/do not have access/i);
		});

		it("returns 'not accessible' when minting the org token 403s (no access)", async () => {
			// Access-denied commonly surfaces as 403, not 401 — same "no access"
			// guidance. Uses the real typed error to exercise status-based detection.
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				fetchOrgBearerToken: vi
					.fn()
					.mockRejectedValue(
						new ThoughtSpotApiError(403, "fetchOrgBearerToken", "forbidden"),
					),
			});
			await server.init();
			const { callTool } = connect(server);
			const res = await callTool("switch_org", { org_id: 999 });
			expect(res.isError).toBe(true);
			expect(res.content[0].text).toMatch(/do not have access/i);
		});
	});

	describe("shared active-org store persists across server instances", () => {
		it("a switch in one instance is visible to another instance with the same token", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const a = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				store,
			});
			await a.server.init();
			await connect(a.server).callTool("switch_org", { org_id: 101 });

			// Second server instance (e.g. a different MCP session/DO) sharing the
			// same store + token.
			const b = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				store,
			});
			await b.server.init();
			const listRes = await connect(b.server).callTool("list_orgs", {});
			const listData = JSON.parse(listRes.content[0].text);
			expect(listData.orgs.find((o: any) => o.is_active).id).toBe(101);
		});

		it("mints the org token ONCE and reuses it across fanned-out instances", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const mint = vi.fn().mockResolvedValue("org-scoped-token");

			// First instance connects + switches -> mints once, persists to store.
			const a = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				store,
				fetchOrgBearerToken: mint,
			});
			await a.server.init();
			await connect(a.server).callTool("switch_org", { org_id: 101 });
			const mintsAfterSwitch = mint.mock.calls.length;
			expect(mintsAfterSwitch).toBeGreaterThan(0);

			// Subsequent fanned-out instances (new DOs) sharing the same store must
			// reuse the stored token, NOT re-mint — this is the whole point of moving
			// the org token into the shared store.
			for (let i = 0; i < 3; i++) {
				const b = makeServer({
					authMode: "oauth",
					session: { orgsEnabled: true },
					store,
					fetchOrgBearerToken: mint,
				});
				await b.server.init();
			}
			expect(mint.mock.calls.length).toBe(mintsAfterSwitch);
		});
	});

	describe("keep-warm token store", () => {
		it("seeds the token store from props on first connect", async () => {
			const tokenStore = new Map<string, any>();
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				tokenStore,
			});
			await server.init();
			// The per-user instance now holds the seeded token + refresh token.
			const seeded = [...tokenStore.values()][0];
			expect(seeded.accessToken).toBe("global-token");
			expect(seeded.refreshToken).toBe("refresh-token");
			expect(seeded.expiresAt).toBe(1893456000000);
		});

		it("does not re-seed when the store already has a (refreshed) token", async () => {
			const tokenStore = new Map<string, any>();
			// Pre-populate as if the alarm already refreshed the token.
			const a = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				tokenStore,
			});
			await a.server.init();
			// Simulate an alarm refresh updating the stored token.
			const key = [...tokenStore.keys()][0];
			tokenStore.set(key, {
				...tokenStore.get(key),
				accessToken: "refreshed-token",
			});

			// A new connection should read the refreshed token, not overwrite it with
			// the (stale) props token.
			const b = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				tokenStore,
			});
			await b.server.init();
			expect(tokenStore.get(key).accessToken).toBe("refreshed-token");
		});

		it("re-seeds from props when the stored token has EXPIRED (refresh chain died)", async () => {
			const tokenStore = new Map<string, any>();
			const a = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				tokenStore,
			});
			await a.server.init();
			// Simulate the refresh chain having died: the stored token is now stale
			// (expiresAt in the past), not merely absent.
			const key = [...tokenStore.keys()][0];
			tokenStore.set(key, {
				...tokenStore.get(key),
				accessToken: "expired-token",
				expiresAt: Date.now() - 60_000,
			});

			// A new connect carries a fresh props token; it must re-seed (heal the
			// chain) rather than trust the expired stored token.
			const b = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				tokenStore,
			});
			await b.server.init();
			expect(tokenStore.get(key).accessToken).toBe("global-token");
		});
	});

	// These exercise withOrgTokenRetry / validateConnectionWithOrgRetry directly
	// rather than through connect().callTool, which deadlocks in mcp-testing-kit
	// when a tool handler throws-then-recovers within a single request. The retry
	// machinery itself is server-internal, so driving it directly is both reliable
	// and a tighter test of the recovery behavior.
	describe("stale org token: reactive 401 re-mint", () => {
		// Put the server into the "org 101 active with an org token" state by
		// switching, then return the server cast to reach its protected helpers.
		async function makeServerWithActiveOrg(opts: {
			store: Map<string, { activeOrgId?: string; orgToken?: string }>;
			mint: ReturnType<typeof vi.fn>;
			validateConnection?: ReturnType<typeof vi.fn>;
		}) {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store: opts.store,
				fetchOrgBearerToken: opts.mint,
				validateConnection: opts.validateConnection,
			});
			await server.init();
			await connect(server).callTool("switch_org", { org_id: 101 });
			return server as unknown as {
				withOrgTokenRetry: <T>(
					recorder: undefined,
					fn: (svc: any) => Promise<T>,
				) => Promise<T>;
				validateConnectionWithOrgRetry: (
					recorder?: undefined,
				) => Promise<boolean>;
				getThoughtSpotService: (recorder?: undefined) => any;
			};
		}

		it("re-mints the org token and retries when an org-scoped call 401s", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			// Each mint returns a uniquely-numbered token so we can identify the
			// re-mint regardless of how many mints happened during connect/switch.
			let mintN = 0;
			const mint = vi
				.fn()
				.mockImplementation(async () => `org-token-${++mintN}`);
			const server = await makeServerWithActiveOrg({ store, mint });
			const tokenBefore = [...store.values()][0].orgToken;
			const mintsBefore = mint.mock.calls.length;

			// A call that 401s once then succeeds: the wrapper should clear+re-mint
			// the org token and retry transparently.
			let calls = 0;
			const result = await server.withOrgTokenRetry(undefined, async () => {
				calls++;
				if (calls === 1) {
					throw new Error("searchOrgs failed with status 401: token expired");
				}
				return ["recovered"];
			});

			expect(result).toEqual(["recovered"]);
			expect(calls).toBe(2); // first 401, retry ok
			expect(mint.mock.calls.length).toBe(mintsBefore + 1); // exactly one re-mint
			// A fresh (different) token replaced the stale one in the shared store.
			const tokenAfter = [...store.values()][0].orgToken;
			expect(tokenAfter).not.toBe(tokenBefore);
			expect(tokenAfter).toBe(`org-token-${mintN}`);
		});

		it("recovers when the 401 is swallowed into an { error } result", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const mint = vi
				.fn()
				.mockResolvedValueOnce("org-token-stale")
				.mockResolvedValue("org-token-fresh");
			const server = await makeServerWithActiveOrg({ store, mint });
			const mintsBefore = mint.mock.calls.length;

			let calls = 0;
			const result = await server.withOrgTokenRetry(undefined, async () => {
				calls++;
				if (calls === 1) {
					// Service methods that catch and return the failure instead of throwing.
					return { error: { message: "failed with status 401: expired" } };
				}
				return { data: "ok" };
			});

			expect(result).toEqual({ data: "ok" });
			expect(calls).toBe(2);
			expect(mint.mock.calls.length).toBe(mintsBefore + 1);
		});

		it("does NOT re-mint when no org token is active (global-token 401 passes through)", async () => {
			// No switch -> withOrgTokenRetry sees no active org token, so a 401 is
			// about the global token and must pass straight through with no re-mint.
			const mint = vi.fn().mockResolvedValue("org-scoped-token");
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: false, currentOrgId: "0" },
				fetchOrgBearerToken: mint,
			});
			await server.init();
			const s = server as unknown as {
				withOrgTokenRetry: <T>(
					recorder: undefined,
					fn: (svc: any) => Promise<T>,
				) => Promise<T>;
			};
			const mintsBefore = mint.mock.calls.length;

			await expect(
				s.withOrgTokenRetry(undefined, async () => {
					throw new Error("failed with status 401: token expired");
				}),
			).rejects.toThrow(/401/);
			// No re-mint attempted.
			expect(mint.mock.calls.length).toBe(mintsBefore);
		});

		it("re-mints + re-validates when validateConnection fails with an org token active", async () => {
			// ThoughtSpotService.validateConnection() probes the cluster via
			// getSessionInfo() and maps a throw -> false. So a stale-token failure
			// surfaces as getSessionInfo throwing a 401. We let it succeed during
			// connect/switch, then throw exactly once (the stale-token call), then
			// succeed again after the re-mint.
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			let mintN = 0;
			const mint = vi
				.fn()
				.mockImplementation(async () => `org-token-${++mintN}`);

			let failNextSessionInfo = false;
			const sessionInfo = {
				clusterId: "c",
				clusterName: "c",
				releaseVersion: "10.13.0",
				userGUID: "u",
				userName: "u",
				currentOrgId: "0",
				privileges: [],
				configInfo: {
					mixpanelConfig: {
						devSdkKey: "k",
						prodSdkKey: "k",
						production: false,
					},
					selfClusterName: "c",
					selfClusterId: "c",
					enableSpotterDataSourceDiscovery: false,
					orgsConfiguration: { enabled: true },
				},
			};
			const getSessionInfo = vi.fn().mockImplementation(async () => {
				if (failNextSessionInfo) {
					failNextSessionInfo = false; // fail exactly once
					throw new Error("getSessionInfo failed with status 401: expired");
				}
				return sessionInfo;
			});

			// Build a client mock with our custom getSessionInfo + mint.
			const client = {
				getSessionInfo,
				searchOrgs: vi.fn().mockResolvedValue([]),
				fetchOrgBearerToken: mint,
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any;
			vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue(
				client,
			);
			const ns = makeStorageNamespace(store, new Map());
			const env = {
				CONVERSATION_STORAGE_OBJECT: ns,
				USER_TOKEN_OBJECT: ns,
			} as any;
			const props = {
				instanceUrl: "https://test.thoughtspot.cloud",
				accessToken: "global-token",
				refreshToken: "refresh-token",
				authMode: "oauth",
				apiVersion: "latest",
				clientName: { clientId: "c", clientName: "c", registrationDate: 0 },
			};
			const server = new MCPServer({ props, env });
			await server.init();
			await connect(server).callTool("switch_org", { org_id: 101 });
			const s = server as unknown as {
				validateConnectionWithOrgRetry: () => Promise<boolean>;
			};
			const mintsBefore = mint.mock.calls.length;
			const sessionCallsBefore = getSessionInfo.mock.calls.length;

			// Now make the next probe (the stale-token attempt) fail once.
			failNextSessionInfo = true;
			const ok = await s.validateConnectionWithOrgRetry();

			expect(ok).toBe(true);
			// Two probes: the failing one, then the post-re-mint success.
			expect(getSessionInfo.mock.calls.length).toBe(sessionCallsBefore + 2);
			expect(mint.mock.calls.length).toBe(mintsBefore + 1);
		});

		it("propagates the error and does not loop if the retry also 401s", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			let mintN = 0;
			const mint = vi
				.fn()
				.mockImplementation(async () => `org-token-${++mintN}`);
			const server = await makeServerWithActiveOrg({ store, mint });
			const mintsBefore = mint.mock.calls.length;

			// Always 401: re-mint happens once, the retry also 401s, and the error is
			// surfaced (exactly two attempts, not an infinite loop).
			let calls = 0;
			await expect(
				server.withOrgTokenRetry(undefined, async () => {
					calls++;
					throw new Error("failed with status 401: still expired");
				}),
			).rejects.toThrow(/401/);
			expect(calls).toBe(2); // initial + one retry only
			expect(mint.mock.calls.length).toBe(mintsBefore + 1); // one re-mint only
		});

		it("passes a non-401 error straight through without re-minting", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			let mintN = 0;
			const mint = vi
				.fn()
				.mockImplementation(async () => `org-token-${++mintN}`);
			const server = await makeServerWithActiveOrg({ store, mint });
			const mintsBefore = mint.mock.calls.length;

			let calls = 0;
			await expect(
				server.withOrgTokenRetry(undefined, async () => {
					calls++;
					throw new Error("failed with status 500: server error");
				}),
			).rejects.toThrow(/500/);
			expect(calls).toBe(1); // no retry for non-401
			expect(mint.mock.calls.length).toBe(mintsBefore); // no re-mint
		});

		it("does not treat a successful non-error result as unauthorized", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			let mintN = 0;
			const mint = vi
				.fn()
				.mockImplementation(async () => `org-token-${++mintN}`);
			const server = await makeServerWithActiveOrg({ store, mint });
			const mintsBefore = mint.mock.calls.length;

			// A normal result that merely contains "401" in unrelated data must not
			// trigger a re-mint — only an { error } shape or a thrown 401 does.
			let calls = 0;
			const result = await server.withOrgTokenRetry(undefined, async () => {
				calls++;
				return { rows: [{ value: "401 Main St" }] };
			});
			expect(result).toEqual({ rows: [{ value: "401 Main St" }] });
			expect(calls).toBe(1);
			expect(mint.mock.calls.length).toBe(mintsBefore);
		});

		it("does not re-mint on a thrown error whose message contains 401 outside the status form", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			let mintN = 0;
			const mint = vi
				.fn()
				.mockImplementation(async () => `org-token-${++mintN}`);
			const server = await makeServerWithActiveOrg({ store, mint });
			const mintsBefore = mint.mock.calls.length;

			// "401" appears (e.g. a datasource id / title), but NOT as "status 401".
			// This must NOT be misread as an auth failure — no re-mint, error passes
			// through. (Guards against the old over-broad \b401\b match.)
			let calls = 0;
			await expect(
				server.withOrgTokenRetry(undefined, async () => {
					calls++;
					throw new Error("datasource 401 not found (status 404)");
				}),
			).rejects.toThrow(/401 not found/);
			expect(calls).toBe(1); // no retry
			expect(mint.mock.calls.length).toBe(mintsBefore); // no re-mint
		});
	});

	describe("idle-activity tracking on tool calls", () => {
		// touchLastSeen is fire-and-forget; flush the microtask queue so the
		// POST /touch lands before we assert.
		const flush = () => new Promise((r) => setTimeout(r, 0));

		it("records activity (POST /touch) on a tool call for OAuth sessions", async () => {
			const touchLog: string[] = [];
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				touchLog,
			});
			await server.init();
			await connect(server).callTool("ping", {});
			await flush();
			expect(touchLog.length).toBeGreaterThan(0);
		});

		it("does NOT record activity for non-OAuth (bearer) sessions", async () => {
			const touchLog: string[] = [];
			const { server } = makeServer({
				authMode: "bearer",
				session: { orgsEnabled: true, currentOrgId: "0" },
				touchLog,
			});
			await server.init();
			await connect(server).callTool("ping", {});
			await flush();
			expect(touchLog.length).toBe(0);
		});
	});
});

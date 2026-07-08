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
				if (
					op === "active-org-id-and-token" &&
					(init?.method ?? "GET") === "GET"
				) {
					return Response.json({
						activeOrgId: rec.activeOrgId ?? null,
						orgToken: rec.orgToken ?? null,
					});
				}
				if (op === "active-org-id-and-token" && init?.method === "POST") {
					const body = JSON.parse(String(init?.body)) as {
						activeOrgId: string;
						orgToken?: string | null;
					};
					// Mirror the real DO (F3): commit id+token atomically when a token
					// is given; otherwise clear the token ONLY on an actual org change.
					if (body.orgToken) {
						store.set(id.name, {
							activeOrgId: body.activeOrgId,
							orgToken: body.orgToken,
						});
					} else {
						const changed = rec.activeOrgId !== body.activeOrgId;
						store.set(id.name, {
							activeOrgId: body.activeOrgId,
							orgToken: changed ? undefined : rec.orgToken,
						});
					}
					return Response.json({ ok: true });
				}
				if (op === "active-org-token" && init?.method === "POST") {
					const body = JSON.parse(String(init?.body)) as { orgToken: string };
					store.set(id.name, { ...rec, orgToken: body.orgToken });
					return Response.json({ ok: true });
				}
				if (op === "global-token-data" && (init?.method ?? "GET") === "GET") {
					const s = tokenStore?.get(id.name);
					return Response.json({
						globalToken: s?.globalToken ?? null,
						expiresAt: s?.expiresAt ?? null,
					});
				}
				if (op === "global-token-data" && init?.method === "POST") {
					tokenStore?.set(id.name, JSON.parse(String(init?.body)));
					return Response.json({ ok: true });
				}
				if (op === "last-seen" && init?.method === "POST") {
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
	noRefreshToken?: boolean;
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
		// Old (pre-multi-org) grants have no refresh token; noRefreshToken emulates one.
		refreshToken: opts.noRefreshToken ? undefined : "refresh-token",
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

		// Backward compatibility: a grant minted before multi-org shipped has no
		// refresh token. Such sessions must NOT see org tools until they re-auth.
		it("hides org tools for a pre-multi-org grant (no refresh token) even with OAuth + orgs enabled", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				noRefreshToken: true,
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).not.toContain("list_orgs");
			expect(names).not.toContain("switch_org");
		});

		it("applies NO org overlay (no active org / no mint) for a pre-multi-org grant", async () => {
			const mint = vi.fn().mockResolvedValue("org-scoped-token");
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				noRefreshToken: true,
				fetchOrgBearerToken: mint,
				store,
			});
			await server.init();
			// Old grant: no active org defaulted, no org token minted → old behavior.
			expect(mint).not.toHaveBeenCalled();
			expect([...store.values()].some((r) => r.activeOrgId)).toBe(false);
		});

		// Org selection is user-aware (shared among re-authed sessions) but must NOT
		// leak into a still-legacy session: an old grant keeps working as-is until it
		// re-authenticates, regardless of a switch elsewhere.
		it("an old-grant session ignores an org switch made by a new session (uses its login token)", async () => {
			// A new session records a switch into the shared store.
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const neu = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
				fetchOrgBearerToken: vi.fn().mockResolvedValue("org-101-token"),
			});
			await neu.server.init();
			await connect(neu.server).callTool("switch_org", { org_id: 101 });
			expect([...store.values()].some((r) => r.activeOrgId === "101")).toBe(
				true,
			);

			// Old-grant session sharing the SAME store (worst case). It must not adopt
			// the switch: no active org, and its bearer stays the login token.
			const old = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
				noRefreshToken: true,
			});
			await old.server.init();
			const s = old.server as unknown as {
				getActiveOrgId(): string | undefined;
				getActiveToken(): string;
			};
			expect(s.getActiveOrgId()).toBeUndefined();
			expect(s.getActiveToken()).toBe("global-token"); // login token, not the org token
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
			expect(seeded?.globalToken).toBe("global-token");
		});

		it("uses the warm global token (not props token) for tool calls when orgs are disabled", async () => {
			const tokenStore = new Map<string, any>();
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: false },
				tokenStore,
			});
			await server.init();
			// Simulate an alarm refresh: stored token is now different from props token.
			const key = [...tokenStore.keys()][0];
			tokenStore.set(key, {
				...tokenStore.get(key),
				globalToken: "refreshed-token",
			});

			// A new connection should pick up the refreshed token.
			const { server: server2 } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: false },
				tokenStore,
			});
			await server2.init();
			// getActiveToken must return the warm token, not the props token.
			expect((server2 as any).getActiveToken()).toBe("refreshed-token");
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
				setActiveOrg: (orgId: string, token: string) => Promise<void>;
				callListOrgs: (recorder: any) => Promise<any>;
			};
			// Put an org token in play (the thing list_orgs must NOT use).
			await s.setActiveOrg("101", "org-101-token");

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

		it("notifies the client to re-list resources on a successful switch (org-specific datasources)", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
			});
			await server.init();
			const notify = vi
				.spyOn(server as any, "sendResourceListChanged")
				.mockResolvedValue(undefined);

			await connect(server).callTool("switch_org", { org_id: 101 });
			expect(notify).toHaveBeenCalledTimes(1);
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

		it("a wrong/invalid org_id (400) is a NO-OP: active org is unchanged", async () => {
			// mint-first: a bad org_id fails the mint (400) BEFORE we commit, so the
			// shared active org must NOT move to the bogus org (important for fan-out:
			// one session's bad switch must not corrupt every session's active org).
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			// First mint (postInit default → org 0) succeeds; the switch mint 400s.
			const mint = vi
				.fn()
				.mockResolvedValueOnce("org-0-token")
				.mockRejectedValue(
					new ThoughtSpotApiError(400, "fetchOrgBearerToken", "bad org"),
				);
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
				fetchOrgBearerToken: mint,
			});
			await server.init();
			const before = { ...[...store.values()][0] };
			expect(before.activeOrgId).toBe("0");

			const res = await connect(server).callTool("switch_org", { org_id: 999 });
			expect(res.isError).toBe(true);
			expect(res.content[0].text).toMatch(/do not have access|does not exist/i);
			// Active org untouched — still org 0 with its token.
			const after = [...store.values()][0];
			expect(after.activeOrgId).toBe("0");
			expect(after.orgToken).toBe(before.orgToken);
		});

		it("a non-4xx mint failure (5xx) returns a generic retry error, NOT 'no access', and is a no-op", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const mint = vi
				.fn()
				.mockResolvedValueOnce("org-0-token")
				.mockRejectedValue(
					new ThoughtSpotApiError(500, "fetchOrgBearerToken", "server error"),
				);
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
				fetchOrgBearerToken: mint,
			});
			await server.init();

			const res = await connect(server).callTool("switch_org", { org_id: 101 });
			expect(res.isError).toBe(true);
			// Generic "try again" — must NOT claim the org is inaccessible on a 5xx.
			expect(res.content[0].text).toMatch(/try again/i);
			expect(res.content[0].text).not.toMatch(/do not have access/i);
			// Still a no-op: active org unchanged.
			expect([...store.values()][0].activeOrgId).toBe("0");
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
			expect(seeded.globalToken).toBe("global-token");
			expect(seeded.globalRefreshToken).toBe("refresh-token");
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
				globalToken: "refreshed-token",
			});

			// A new connection should read the refreshed token, not overwrite it with
			// the (stale) props token.
			const b = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				tokenStore,
			});
			await b.server.init();
			expect(tokenStore.get(key).globalToken).toBe("refreshed-token");
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
				globalToken: "expired-token",
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
			expect(tokenStore.get(key).globalToken).toBe("global-token");
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
				validateConnectionWithOrgRetry: (
					recorder?: undefined,
				) => Promise<boolean>;
				getThoughtSpotService: (recorder?: undefined) => any;
			};
		}

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

	// Org isolation on data calls: an active org must always use its org-scoped
	// token + header; the global token must never authenticate a data call.
	describe("data-call org isolation (never the global token)", () => {
		// Build an OAuth+orgs server already switched into org 101, returning the
		// server plus the getThoughtSpotClient spy for asserting outbound (bearer,
		// orgId) pairs.
		async function serverInOrg(
			store = new Map<string, { activeOrgId?: string; orgToken?: string }>(),
			mint = vi.fn().mockResolvedValue("org-101-token"),
		) {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
				fetchOrgBearerToken: mint,
			});
			await server.init();
			await connect(server).callTool("switch_org", { org_id: 101 });
			const spy = vi.mocked(thoughtspotClient.getThoughtSpotClient);
			return { server: server as any, store, mint, spy };
		}

		// A1: an org-active data path builds its client with the org token + header.
		it("uses the org-scoped token and org id (header) on a data call", async () => {
			const { server } = await serverInOrg();
			// getThoughtSpotService() sources token + org id from these two methods.
			expect(server.getActiveToken()).toBe("org-101-token");
			expect(server.getActiveOrgId()).toBe("101");
		});

		// A2: fail-closed — org active but no token cached => throw, never global.
		it("throws (never falls back to global) if the org token is missing", async () => {
			const { server } = await serverInOrg();
			// Simulate the token being gone from memory (e.g. mid-remint window)
			// while the active org id remains set.
			server.activeOrgToken = undefined;
			expect(() => server.getActiveToken()).toThrow(/token is not minted/);
		});

		// A_new: postInit mints the org token on connect so data tool calls have it ready.
		it("mints the org token on connect so data tool calls can use it", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const mint = vi.fn().mockResolvedValue("org-101-token");
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
				fetchOrgBearerToken: mint,
			});
			await server.init();
			await connect(server).callTool("switch_org", { org_id: 101 });
			// After connect + switch, the token is available without any per-tool mint.
			const s = server as any;
			expect(s.activeOrgToken).toBe("org-101-token");
			expect(() => s.getActiveToken()).not.toThrow();
		});

		// list_orgs / mint still use the global token, header-less.
		it("switch_org mint uses the global token with no org header", async () => {
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
			const spy = vi.mocked(thoughtspotClient.getThoughtSpotClient);
			spy.mockClear();
			await connect(server).callTool("switch_org", { org_id: 101 });
			// The mint client is built global-token + no org id.
			const mintClient = spy.mock.calls.find((c) => c[1] === "global-token");
			expect(mintClient).toBeDefined();
			expect(mintClient?.[2]).toBeUndefined();
		});
	});

	// F2(a): re-mint mints first, then overwrites atomically — the shared store is
	// never observed without a token, so concurrent siblings can't read a
	// tokenless active org.
	describe("re-mint is mint-first (store never tokenless)", () => {
		it("keeps the old token in the store until the new one replaces it", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			let mintN = 0;
			let assertStoreHasToken = false;
			const mint = vi.fn().mockImplementation(async () => {
				// On the RE-mint (not the initial switch) the store must still hold the
				// previous token when the new one is being minted — never empty.
				if (assertStoreHasToken) {
					const rec = [...store.values()].find((r) => r.activeOrgId === "101");
					expect(rec?.orgToken).toBeTruthy();
				}
				return `org-token-${++mintN}`;
			});
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
				fetchOrgBearerToken: mint,
			});
			await server.init();
			await connect(server).callTool("switch_org", { org_id: 101 });
			const rec101 = () =>
				[...store.values()].find((r) => r.activeOrgId === "101");
			const before = rec101()?.orgToken;
			expect(before).toBeTruthy();
			assertStoreHasToken = true;
			await (server as any).forceRecreateActiveOrgToken(undefined);
			const after = rec101()?.orgToken;
			expect(after).toBeTruthy();
			expect(after).not.toBe(before);
		});

		it("leaves the old token intact if the re-mint throws", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			let failNext = false;
			const mint = vi.fn().mockImplementation(async () => {
				if (failNext) throw new Error("mint failed with status 500");
				return "org-101-token";
			});
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
				fetchOrgBearerToken: mint,
			});
			await server.init();
			await connect(server).callTool("switch_org", { org_id: 101 });
			const rec101 = () =>
				[...store.values()].find((r) => r.activeOrgId === "101");
			const before = rec101()?.orgToken;
			expect(before).toBeTruthy();
			failNext = true; // the re-mint will throw
			await expect(
				(server as any).forceRecreateActiveOrgToken(undefined),
			).rejects.toThrow();
			// The store still holds the prior valid token — not cleared.
			expect(rec101()?.orgToken).toBe(before);
		});
	});

	// Fan-out consistency across separate server instances sharing one store.
	describe("fan-out consistency", () => {
		// F1: a switch in instance A is seen by instance B's next call.
		it("B sees A's switch on its next tool call (per-request reload)", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const a = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
			});
			const b = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
			});
			await a.server.init();
			await b.server.init();
			await connect(a.server).callTool("switch_org", { org_id: 101 });
			const listRes = await connect(b.server).callTool("list_orgs", {});
			const parsed = JSON.parse((listRes as any).content[0].text);
			const active = parsed.orgs.find((o: any) => o.is_active);
			expect(String(active.id)).toBe("101");
		});

		// E13: two sequential switches to different orgs — last write wins.
		it("last-write-wins across concurrent switches to different orgs", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const a = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
			});
			const b = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
			});
			await a.server.init();
			await b.server.init();
			await connect(a.server).callTool("switch_org", { org_id: 101 });
			await connect(b.server).callTool("switch_org", { org_id: 0 });
			// B committed last → the shared store reflects org 0.
			expect([...store.values()][0].activeOrgId).toBe("0");
		});

		// F4: datasource cache refetches after the active org changes.
		it("refetches datasources after an org switch (org-tagged cache)", async () => {
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
			const s = server as any;
			let fetches = 0;
			s.getThoughtSpotService = () => ({
				getDataSources: async () => {
					fetches++;
					return [{ id: `ds-${s.getActiveOrgId()}`, name: "x" }];
				},
			});
			s.activeOrgId = "0";
			await s.getDatasources();
			await s.getDatasources(); // same org → cached
			expect(fetches).toBe(1);
			s.activeOrgId = "101"; // org changed
			await s.getDatasources(); // must refetch
			expect(fetches).toBe(2);
		});
	});

	// T3: the global token is re-read from the store before minting/listing, so a
	// long-lived instance picks up an alarm-rotated token.
	describe("global token freshness (T3)", () => {
		it("re-reads the store's refreshed token before minting", async () => {
			const store = new Map<
				string,
				{ activeOrgId?: string; orgToken?: string }
			>();
			const tokenStore = new Map<string, any>();
			const mint = vi.fn().mockResolvedValue("org-101-token");
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
				store,
				tokenStore,
				fetchOrgBearerToken: mint,
			});
			await server.init();
			// The alarm rotated the store's global token after connect.
			const key = [...tokenStore.keys()][0];
			tokenStore.set(key, {
				globalToken: "rotated-global",
				expiresAt: 1893456000000,
			});
			await connect(server).callTool("switch_org", { org_id: 101 });
			// The mint used the rotated token, not the connect-time "global-token".
			const spy = vi.mocked(thoughtspotClient.getThoughtSpotClient);
			const mintClient = spy.mock.calls.find((c) => c[1] === "rotated-global");
			expect(mintClient).toBeDefined();
		});
	});
});

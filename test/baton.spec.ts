import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import {
	BATON_CLUSTERS_ENV_VAR,
	BatonClustersConfigError,
	batonClusterName,
	batonPrincipal,
	batonToolCatalog,
	installBaton,
	parseBatonClusters,
} from "../src/baton";
import { VERSION_REGISTRY } from "../src/servers/version-registry";
import type { SessionInfo } from "../src/services/types";

const PICKED = "https://team1.thoughtspot.cloud";
const UNPICKED = "https://other.thoughtspot.cloud";
const COLLECTOR_HOST = "collector.example.com";
const DSN = `https://baton_pk_testkey@${COLLECTOR_HOST}/ten_0123abcd/srv-test`;

const ENV = {
	[BATON_CLUSTERS_ENV_VAR]: JSON.stringify({ [PICKED]: "demo-cluster" }),
	BATON_DSN: DSN,
};

const TOOLS = [
	{
		name: "ping",
		description: "Check the connection",
		inputSchema: { type: "object" as const, properties: {} },
	},
	{
		name: "get_answer",
		description: "Answer a question",
		inputSchema: {
			type: "object" as const,
			properties: { question: { type: "string" } },
			required: ["question"],
		},
	},
];

function buildServer(
	handler = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "ok" }],
	})),
) {
	const server = new Server(
		{ name: "ThoughtSpot", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOLS,
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) =>
		handler(request.params.name, request.params.arguments),
	);
	return { server, handler };
}

async function connectClient(server: Server): Promise<Client> {
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return client;
}

let fetchMock: ReturnType<typeof vi.fn>;

function collectorRequests() {
	return fetchMock.mock.calls.filter(([input]) =>
		String(input instanceof Request ? input.url : input).includes(
			COLLECTOR_HOST,
		),
	);
}

async function collectorBodies(): Promise<string> {
	const bodies = await Promise.all(
		collectorRequests().map(async ([input, init]) =>
			input instanceof Request
				? input.clone().text()
				: String(init?.body ?? ""),
		),
	);
	return bodies.join("\n");
}

type SentEvent = {
	principal: { id: string } | null;
	organization: { id: string } | null;
};

async function collectorEvents(): Promise<SentEvent[]> {
	return (await collectorBodies())
		.split("\n")
		.filter(Boolean)
		.flatMap((body) => JSON.parse(body).events as SentEvent[]);
}

beforeEach(() => {
	fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	// Baton keeps sending after a test ends, and the real fetch would go to the network.
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 202 }));
});

describe("parseBatonClusters", () => {
	it("is empty when unset or blank", () => {
		expect(parseBatonClusters(undefined).size).toBe(0);
		expect(parseBatonClusters(null).size).toBe(0);
		expect(parseBatonClusters("  ").size).toBe(0);
		expect(parseBatonClusters("{}").size).toBe(0);
	});

	it("reads a JSON string or an already-parsed object", () => {
		expect(
			parseBatonClusters(JSON.stringify({ [PICKED]: "demo-cluster" })).get(
				PICKED,
			),
		).toBe("demo-cluster");
		expect(
			parseBatonClusters({ [`${PICKED}/`]: " demo-cluster " }).get(PICKED),
		).toBe("demo-cluster");
	});

	it.each([
		["invalid JSON", "{not json"],
		["an array", JSON.stringify([PICKED])],
		["a non-string name", JSON.stringify({ [PICKED]: 1 })],
		["an empty name", JSON.stringify({ [PICKED]: " " })],
		["a name over 64 characters", JSON.stringify({ [PICKED]: "x".repeat(65) })],
		["an invalid URL", JSON.stringify({ "not a url": "demo-cluster" })],
	])("rejects %s", (_label, raw) => {
		expect(() => parseBatonClusters(raw)).toThrow(BatonClustersConfigError);
	});
});

describe("batonClusterName", () => {
	it("names a picked instance and matches its normalized URL", () => {
		expect(batonClusterName(ENV, PICKED)).toBe("demo-cluster");
		expect(batonClusterName(ENV, `${PICKED}/`)).toBe("demo-cluster");
	});

	it("is undefined for an unpicked, missing or invalid instance", () => {
		expect(batonClusterName(ENV, UNPICKED)).toBeUndefined();
		expect(batonClusterName(ENV, undefined)).toBeUndefined();
		expect(batonClusterName(ENV, "not a url")).toBeUndefined();
		expect(batonClusterName(undefined, PICKED)).toBeUndefined();
	});

	it("never matches a substring of a picked URL", () => {
		expect(
			batonClusterName(ENV, "https://team1.thoughtspot.cloud.evil.com"),
		).toBeUndefined();
	});

	it("is undefined, and logs, when the config is malformed", () => {
		expect(
			batonClusterName({ [BATON_CLUSTERS_ENV_VAR]: "{bad" }, PICKED),
		).toBeUndefined();
		expect(console.error).toHaveBeenCalled();
	});
});

describe("batonToolCatalog", () => {
	it("holds every tool of every API version, once per name", () => {
		const names = batonToolCatalog().map((tool) => tool.name);
		const registryNames = VERSION_REGISTRY.flatMap((version) =>
			version.tools.map((tool) => tool.name),
		);
		expect(new Set(names)).toEqual(new Set(registryNames));
		expect(names).toHaveLength(new Set(names).size);
	});
});

const SESSION = {
	userGUID: "guid-123",
	userName: "Ana Analyst",
	currentOrgId: "7",
	configInfo: { orgsConfiguration: { enabled: true } },
} as unknown as SessionInfo;

describe("batonPrincipal", () => {
	it("is the cluster alone when there is no session", () => {
		expect(batonPrincipal("demo-cluster", undefined)).toEqual({
			organizationId: "demo-cluster",
			displayName: "demo-cluster",
			labels: ["demo-cluster"],
		});
	});

	it("is the user inside their ThoughtSpot Org when Orgs are on", () => {
		expect(batonPrincipal("demo-cluster", SESSION)).toEqual({
			principalId: "guid-123",
			displayName: "Ana Analyst",
			organization: {
				organizationId: "demo-cluster:7",
				displayName: "demo-cluster · org 7",
				labels: ["demo-cluster"],
			},
		});
	});

	it("is the user inside the cluster when Orgs are off, named by GUID without a user name", () => {
		const session = {
			...SESSION,
			userName: "",
			configInfo: { orgsConfiguration: { enabled: false } },
		} as unknown as SessionInfo;
		expect(batonPrincipal("demo-cluster", session)).toEqual({
			principalId: "guid-123",
			displayName: "guid-123",
			organization: {
				organizationId: "demo-cluster",
				displayName: "demo-cluster",
				labels: ["demo-cluster"],
			},
		});
	});
});

describe("installBaton", () => {
	it.each([
		["the instance is not picked", ENV, UNPICKED],
		["BATON_CLUSTERS is unset", { BATON_DSN: DSN }, PICKED],
		[
			"BATON_CLUSTERS is an empty string",
			{ ...ENV, [BATON_CLUSTERS_ENV_VAR]: "" },
			PICKED,
		],
		[
			"BATON_CLUSTERS is an empty object",
			{ ...ENV, [BATON_CLUSTERS_ENV_VAR]: "{}" },
			PICKED,
		],
		[
			"BATON_CLUSTERS is malformed",
			{ ...ENV, [BATON_CLUSTERS_ENV_VAR]: "{bad" },
			PICKED,
		],
		[
			"BATON_DSN is unset",
			{ [BATON_CLUSTERS_ENV_VAR]: ENV[BATON_CLUSTERS_ENV_VAR] },
			PICKED,
		],
		["there is no env", undefined, PICKED],
	])(
		"leaves the server unchanged and sends nothing when %s",
		async (_label, env, instanceUrl) => {
			const { server, handler } = buildServer();
			expect(await installBaton(server, env, instanceUrl)).toBe(false);

			const client = await connectClient(server);
			const { tools } = await client.listTools();
			expect(tools).toEqual(TOOLS);

			await client.callTool({
				name: "get_answer",
				arguments: { question: "q" },
			});
			expect(handler).toHaveBeenCalledWith("get_answer", { question: "q" });
			expect(collectorRequests()).toHaveLength(0);
		},
	);

	it("adds user_goal and the report tool for a picked instance", async () => {
		const { server } = buildServer();
		expect(await installBaton(server, ENV, PICKED)).toBe(true);

		const client = await connectClient(server);
		const { tools } = await client.listTools();
		const answer = tools.find((tool) => tool.name === "get_answer");
		expect(answer?.inputSchema.properties).toHaveProperty("user_goal");
		expect(tools.length).toBe(TOOLS.length + 1);
		const report = tools.find(
			(tool) => !TOOLS.some((t) => t.name === tool.name),
		);
		const context = (
			report?.inputSchema.properties as Record<
				string,
				{ additionalProperties?: unknown }
			>
		)?.context;
		expect(context?.additionalProperties).toBe(true);
	});

	it("takes user_goal off before the handler and records the call", async () => {
		const { server, handler } = buildServer();
		await installBaton(server, ENV, PICKED);
		const client = await connectClient(server);
		await client.listTools();

		await client.callTool({
			name: "get_answer",
			arguments: { question: "top regions", user_goal: "plan Q3 targets" },
		});

		expect(handler).toHaveBeenCalledWith("get_answer", {
			question: "top regions",
		});
		await vi.waitFor(async () =>
			expect(await collectorBodies()).toContain("demo-cluster"),
		);
	});

	it("knows the catalog's tools on a call that no tools/list preceded", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		onTestFinished(() => {
			warn.mockRestore();
			error.mockRestore();
		});
		const { server, handler } = buildServer();
		await installBaton(server, ENV, PICKED);
		const client = await connectClient(server);
		const name = batonToolCatalog()[0].name;

		await client.callTool({ name, arguments: { user_goal: "g" } });

		expect(handler).toHaveBeenCalledWith(name, {});
		const stderr = globalThis.process?.stderr?.write;
		const warnings = [
			...warn.mock.calls,
			...error.mock.calls,
			...(vi.isMockFunction(stderr) ? stderr.mock.calls : []),
		].map(String);
		expect(warnings.filter((w) => w.includes("not in any tool list"))).toEqual(
			[],
		);
	});

	it("records the ThoughtSpot user and org on each event", async () => {
		const { server } = buildServer();
		await installBaton(server, ENV, PICKED, () => SESSION);
		const client = await connectClient(server);

		await client.callTool({
			name: "get_answer",
			arguments: { question: "q", user_goal: "g" },
		});

		await vi.waitFor(async () =>
			expect(await collectorEvents()).toContainEqual(
				expect.objectContaining({
					principal: expect.objectContaining({ id: "guid-123" }),
					organization: expect.objectContaining({ id: "demo-cluster:7" }),
				}),
			),
		);
	});

	it("records only the cluster when the cached session cannot be read", async () => {
		const { server, handler } = buildServer();
		await installBaton(server, ENV, PICKED, () => {
			throw new Error("session info down");
		});
		const client = await connectClient(server);

		const result = await client.callTool({
			name: "get_answer",
			arguments: { question: "q", user_goal: "g" },
		});

		expect(result.isError).toBeFalsy();
		expect(handler).toHaveBeenCalledWith("get_answer", { question: "q" });
		await vi.waitFor(async () =>
			expect(await collectorEvents()).toContainEqual(
				expect.objectContaining({
					principal: null,
					organization: expect.objectContaining({ id: "demo-cluster" }),
				}),
			),
		);
	});

	it("still runs a call that has no user_goal", async () => {
		const { server, handler } = buildServer();
		await installBaton(server, ENV, PICKED);
		const client = await connectClient(server);
		await client.listTools();

		const result = await client.callTool({ name: "ping", arguments: {} });

		expect(result.isError).toBeFalsy();
		expect(handler).toHaveBeenCalledWith("ping", {});
	});

	it.each([
		["rejects", () => Promise.reject(new TypeError("network down"))],
		["returns 500", async () => new Response("down", { status: 500 })],
		["never responds", () => new Promise<Response>(() => {})],
	])(
		"keeps tool calls working when the collector %s",
		async (_label, collector) => {
			fetchMock.mockImplementation(collector);
			const { server, handler } = buildServer();
			await installBaton(server, ENV, PICKED);
			const client = await connectClient(server);
			await client.listTools();

			const result = await client.callTool({
				name: "get_answer",
				arguments: { question: "q", user_goal: "g" },
			});

			expect(result.isError).toBeFalsy();
			expect(handler).toHaveBeenCalledWith("get_answer", { question: "q" });
		},
	);

	it("returns false, and the server keeps working, when the SDK throws", async () => {
		vi.resetModules();
		vi.doMock("@goodtiming/baton-sdk", () => ({
			withBaton: () => {
				throw new Error("bad config");
			},
		}));
		const { installBaton: install } = await import("../src/baton");
		const { server } = buildServer();

		expect(await install(server, ENV, PICKED)).toBe(false);
		const client = await connectClient(server);
		expect((await client.listTools()).tools).toEqual(TOOLS);

		vi.doUnmock("@goodtiming/baton-sdk");
		vi.resetModules();
	});
});

# Adding a New Tool to the ThoughtSpot MCP Server

This guide walks through the full lifecycle of adding a new MCP tool: where the
pieces live, the order to touch them in, how to test against a real
ThoughtSpot instance, and how to debug the issues you will almost certainly
hit the first time.

The running example is `get_audit_logs` — an admin-only tool that fetches
security/audit log entries from a TS instance. Wherever you see it referenced,
you can swap in the name of the tool you are building.

---

## 1. Architecture at a glance

```
┌────────────────────────────────────────────────────────────────────────────┐
│ MCP client (Claude Code, Claude Desktop, Inspector, ChatGPT, …)            │
└────────────────────────────────────────────────────────────────────────────┘
                            │  JSON-RPC over Streamable HTTP / SSE
                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Cloudflare Worker entrypoint   src/index.ts                                │
│   • OTEL trace setup, header stripping, request metrics                    │
│   • Hands off to OAuthProvider                                             │
└────────────────────────────────────────────────────────────────────────────┘
                            │
       ┌────────────────────┴────────────────────┐
       ▼                                         ▼
 OAuth-protected routes              Bearer / token routes
 /mcp  /sse                          /bearer/*  (V1-pinned)
                                     /token/*   (V2 latest by default)
                                     src/bearer.ts
                            │
                            ▼  ctx.props = { accessToken, instanceUrl, apiVersion, … }
┌────────────────────────────────────────────────────────────────────────────┐
│ MCPServer (Durable Object)         src/servers/mcp-server.ts               │
│   extends BaseMCPServer            src/servers/mcp-server-base.ts          │
│                                                                            │
│   listTools()   ← uses VERSION_REGISTRY to pick toolDefinitionsV1 / V2     │
│   callTool()    ← switch on ToolName, dispatch to call<Tool>() handler     │
│   call<Tool>()  ← parses args, calls ThoughtSpotService, builds response   │
└────────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ ThoughtSpotService   src/thoughtspot/thoughtspot-service.ts                │
│   • Wraps every upstream call in observeUpstreamCall() for metrics        │
│   • Uses ThoughtSpotRestApi (and a few custom handlers) under the hood     │
└────────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ ThoughtSpot REST API    src/thoughtspot/thoughtspot-client.ts              │
│   • Either the official SDK method, or a custom `fetch` handler for        │
│     endpoints the SDK does not expose yet                                  │
└────────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    ThoughtSpot instance
```

### Key file map

| Concern                          | File                                              |
| -------------------------------- | ------------------------------------------------- |
| Zod input/output schemas + descriptors | `src/servers/tool-definitions.ts`           |
| Which tools each API version exposes | `src/servers/version-registry.ts`             |
| `callTool` dispatch + handlers   | `src/servers/mcp-server.ts`                       |
| Response helpers, session init   | `src/servers/mcp-server-base.ts`                  |
| Service-layer methods            | `src/thoughtspot/thoughtspot-service.ts`          |
| Raw HTTP / SDK injection         | `src/thoughtspot/thoughtspot-client.ts`           |
| Upstream metric names            | `src/metrics/runtime/tool-metrics.ts`             |
| Bearer / token auth routing      | `src/bearer.ts`                                   |
| Public route paths               | `src/routes.ts`                                   |
| Tests                            | `test/servers/mcp-server.spec.ts`, etc.           |

---

## 2. The seven-step recipe

Touch these layers in this order. Each step is small and reviewable on its
own.

### Step 1 — Define schemas (`tool-definitions.ts`)

Add Zod schemas for both input and output, plus an enum entry. Both schemas
become the source of truth: input is used to validate arguments at runtime,
output is advertised to the agent so it knows what shape to expect.

```ts
// src/servers/tool-definitions.ts

export const GetAuditLogsInputSchema = z.object({
  start_epoch_ms: z.number().int().describe("Start of the time window ..."),
  end_epoch_ms:   z.number().int().describe("End of the time window ..."),
  get_all_logs:   z.boolean().optional().describe(
    "True (default) fetches across all orgs; false scopes to current org.",
  ),
});

export const AuditLogEntrySchema = z.object({
  timestamp:   z.string(),
  event_type:  z.string(),
  description: z.string().optional(),
  user_guid:   z.string().optional(),
  user_name:   z.string().optional(),
  ip_address:  z.string().optional(),
  org_id:      z.number().optional(),
  details:     z.record(z.any()).optional(),
});

export const GetAuditLogsOutputSchema = z.object({
  logs:        z.array(AuditLogEntrySchema),
  total_count: z.number(),
});

export enum ToolName {
  // ...
  GetAuditLogs = "get_audit_logs",
}
```

**Schema design tips**

- Make optional fields actually optional — agents handle absent better than
  empty-string/null clutter.
- Use `.describe()` liberally. The agent reads these to know when and how to
  call your tool.
- Bound numeric inputs (`.min`, `.max`) so the agent cannot ask for absurd
  pagination ranges.
- Keep field names snake_case to match what the rest of the codebase
  advertises.

### Step 2 — Add the tool descriptor

Append a descriptor object to `toolDefinitionsV2` (or `V1` if you're
extending the legacy surface — almost certainly **V2**):

```ts
{
  name: ToolName.GetAuditLogs,
  description:
    "Admin-only: fetch ThoughtSpot security/audit log entries for a given " +
    "time window. The caller must have ADMINISTRATION privilege ... " +
    "Set `get_all_logs` to false when the user asks for current-org-only.",
  inputSchema:  zodToJsonSchema(GetAuditLogsInputSchema)  as ToolInput,
  outputSchema: zodToJsonSchema(GetAuditLogsOutputSchema) as ToolOutput,
  annotations: {
    title: "Get Audit Logs",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
},
```

The description is the agent's main signal for when to call your tool — be
explicit about prerequisites (e.g. admin privilege), inputs that map to user
intent (`get_all_logs: false` ≈ "current org only"), and constraints (e.g.
24-hour window).

### Step 3 — Register an upstream metric name

```ts
// src/metrics/runtime/tool-metrics.ts
export const UPSTREAM_OPERATION_NAMES = {
  // ...
  getAuditLogs: "get_audit_logs",
} as const;
```

`observeUpstreamCall` uses this label for duration/outcome metrics. Keep the
name consistent with the upstream API surface, not the internal method name.

### Step 4 — Add a service method (`thoughtspot-service.ts`)

The service layer is the boundary between MCP-shaped requests and the TS
REST API. Wrap every upstream call in `observeUpstreamCall` so metrics fire.

```ts
@WithSpan("get-audit-logs")
async getAuditLogs(params: {
  startEpochMs: number;
  endEpochMs: number;
  getAllLogs?: boolean;
}): Promise<GetAuditLogsResponse> {
  const span = getActiveSpan();
  span?.setAttributes({
    start_epoch_ms: params.startEpochMs,
    end_epoch_ms:   params.endEpochMs,
    get_all_logs:   params.getAllLogs ?? true,
  });

  return this.observeUpstreamCall<GetAuditLogsResponse>(
    UPSTREAM_OPERATION_NAMES.getAuditLogs,
    () => (this.client as any).getAuditLogs({
      ...params,
      getAllLogs: params.getAllLogs ?? true,
    }),
  );
}
```

**Always declare the return type explicitly.** `observeUpstreamCall<T>` is
generic; without an explicit annotation TS narrows `T` to `unknown` (because
`(this.client as any).method()` returns `any` which doesn't flow through
generic inference cleanly), and callers see `'result' is of type 'unknown'`
errors.

### Step 5 — Add a client handler if the SDK lacks the endpoint

If `@thoughtspot/rest-api-sdk` already exposes the method (`searchMetadata`,
`exportAnswerReport`, etc.), you can call it directly from the service —
skip this step.

If it doesn't (audit logs, prism GraphQL, etc.), inject a custom handler in
`thoughtspot-client.ts` next to the others (`addGetSessionInfo`,
`addGetAnswerSession`, …):

```ts
function addGetAuditLogs(client: any, instanceUrl: string, token: string) {
  (client as any).getAuditLogs = async (
    params: GetAuditLogsParams,
  ): Promise<GetAuditLogsResponse> => {
    const response = await fetch(`${instanceUrl}/api/rest/2.0/logs/fetch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "user-agent": "ThoughtSpot-ts-client",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        log_type: "SECURITY_AUDIT",
        start_epoch_time_in_millis: params.startEpochMs,
        end_epoch_time_in_millis:   params.endEpochMs,
        get_all_logs:               params.getAllLogs ?? true,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `getAuditLogs failed with status ${response.status}: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as any;
    // … normalize wire shape into AuditLogEntry[] (see Step 5a) …
    return { logs, total_count: logs.length };
  };
}
```

Wire it up in `getThoughtSpotClient`:

```ts
addGetAuditLogs(client, instanceUrl, bearerToken);
```

#### Step 5a — Normalize upstream response shapes

Upstream responses rarely match the shape you want to advertise to the
agent. Do the shaping **in the client handler**, not the service or tool
layer — that way the rest of the stack sees a clean, typed object.

Real example from audit logs: the API returns
`{ date, log: "<stringified JSON>" }` per record. The handler unwraps that:

```ts
const logs: AuditLogEntry[] = rawLogs.map((entry) => {
  let payload: any = {};
  if (typeof entry.log === "string") {
    try { payload = JSON.parse(entry.log); } catch {}
  }

  const normalized: AuditLogEntry = {
    timestamp:  payload.ts ?? entry.date ?? new Date().toISOString(),
    event_type: payload.type ?? "UNKNOWN",
  };
  if (payload.desc)     normalized.description = payload.desc;
  if (payload.userGUID) normalized.user_guid   = payload.userGUID;
  if (payload.cIP)      normalized.ip_address  = payload.cIP;   // drops null
  // …
  return normalized;
});
```

Notes:

- Use truthy checks (`if (payload.cIP)`) rather than `!== undefined` when you
  want to drop both `null` and `""` upstream values.
- Defensive parse — if the upstream string isn't JSON, fall back to outer
  fields rather than crashing.
- Only project fields you've documented in the schema. Do not blindly spread
  `payload.data` (or whatever the upstream "inner blob" field is) into
  `details` — agents will get inconsistent shapes.

### Step 6 — Wire the handler into `callTool`

```ts
// src/servers/mcp-server.ts

switch (name) {
  // ...
  case ToolName.GetAuditLogs:
    return this.callGetAuditLogs(request, recorder);
  default:
    throw new Error(`Unknown tool: ${name}`);
}

@WithSpan("call-get-audit-logs")
async callGetAuditLogs(
  request: z.infer<typeof CallToolRequestSchema>,
  recorder: MetricsRecorder,
) {
  const span = this.initSpanWithCommonAttributes();

  // ─── Auth gate (when applicable) ────────────────────────────────────
  const privileges: string[] = Array.isArray(this.sessionInfo?.privileges)
    ? this.sessionInfo.privileges
    : [];
  const isAdmin = privileges.includes("ADMINISTRATION");
  span?.setAttribute("is_admin", isAdmin);
  if (!isAdmin) {
    return this.createErrorResponse(
      "This tool requires ADMINISTRATION privilege.",
      "Audit log fetch denied: not admin",
    );
  }

  // ─── Validate inputs ────────────────────────────────────────────────
  const args = GetAuditLogsInputSchema.parse(request.params.arguments);
  if (args.end_epoch_ms <= args.start_epoch_ms) {
    return this.createErrorResponse(
      "`end_epoch_ms` must be greater than `start_epoch_ms`.",
      "Audit log fetch invalid window",
    );
  }

  // ─── Call the service, build the response ───────────────────────────
  try {
    const result = await this.getThoughtSpotService(recorder).getAuditLogs({
      startEpochMs: args.start_epoch_ms,
      endEpochMs:   args.end_epoch_ms,
      getAllLogs:   args.get_all_logs,
    });
    return this.createStructuredContentSuccessResponse(
      { logs: result.logs, total_count: result.total_count },
      "Audit logs fetched successfully",
    );
  } catch (error) {
    return this.createErrorResponse(
      "Failed to fetch audit logs.",
      `Audit log fetch error: ${(error as Error).message}`,
    );
  }
}
```

**Response-helper conventions** (defined in `mcp-server-base.ts`):

| Helper                                       | When to use                                            |
| -------------------------------------------- | ------------------------------------------------------ |
| `createSuccessResponse(message)`             | Single human-readable text response                    |
| `createStructuredContentSuccessResponse(obj)`| Has a typed payload matching your `outputSchema`       |
| `createErrorResponse(userMsg, statusMsg)`    | Tool failure. First arg is shown to the agent; second is logged server-side. **Never** put PII or stack details in the first arg. |

### Step 7 — Tests

Add a `describe` block in `test/servers/mcp-server.spec.ts`. Use the
`mcp-testing-kit` `connect()` helper and stub the service layer with
`vi.spyOn(ThoughtSpotService.prototype, "<method>")`.

Cover at minimum:

1. Happy path with valid inputs.
2. Auth gate (e.g. non-admin caller) if you added one.
3. Input validation rejection.
4. Upstream error propagation.

Don't forget to update the **list-tools count assertion** at the top of the
`describe("List Tools", ...)` block — every new V2 tool bumps that number.

```ts
expect(result.tools).toHaveLength(6);
expect(result.tools?.map((t) => t.name)).toEqual([
  "check_connectivity",
  "create_analysis_session",
  // …,
  "get_audit_logs",
]);
```

---

## 3. The V1 vs V2 trap — read this before testing

`src/servers/version-registry.ts` maintains a registry of `VersionConfig`s,
each with an array of which tool descriptors it advertises.

| API version label                          | Tool list             |
| ------------------------------------------ | --------------------- |
| `backwards-compatibility-default`, `2025-01-01` | `toolDefinitionsV1` (legacy 5 tools) |
| `latest`, `2026-05-01`                     | `toolDefinitionsV2`   |
| `beta`                                     | `toolDefinitionsV2`   |

How the API version is selected per endpoint, from `src/bearer.ts`:

```
/mcp, /sse              → from ?api-version=… query param (defaults to legacy)
/bearer/mcp, /bearer/sse → hard-pinned to "backwards-compatibility-default"
/token/mcp, /token/sse  → ?api-version=… (defaults to "latest")
```

**Consequence:** if you add a tool to V2 and try to test it via `/bearer/*`,
**it will not appear in `tools/list`.** This will eat half a day if you
don't catch it early. Always test new V2 tools against `/token/mcp` (or
`/token/mcp?api-version=latest` to be explicit).

If your tool needs to be exposed on older versions, you must add it to
`toolDefinitionsV1` and possibly cut a new dated entry at the top of
`VERSION_REGISTRY` — see `version-registry.ts` for the chronological-order
rules.

---

## 4. Local testing — three options, easiest first

Run the dev server in one terminal:

```bash
npm run dev          # http://localhost:8787
# or
npm run start        # https://localhost:8787 (uses local cert)
```

The worker hot-reloads on file save. You do **not** need to restart wrangler
when you change tool code.

### 4a. Connect Claude Code (recommended)

```bash
claude mcp add thoughtspot-local \
  --transport http \
  --header "Authorization: Bearer <TS_TOKEN>@my-instance.thoughtspot.cloud" \
  -- "http://localhost:8787/token/mcp?api-version=latest"
```

- Use a token belonging to a user with whatever privileges your tool gates
  on (admin if you copied the audit logs pattern).
- The TS host goes **without** `https://` after the `@` — the bearer parser
  splits on `@` and a scheme breaks the split. `validateAndSanitizeUrl` adds
  `https://` for you.
- Start a **new** Claude Code conversation after registering; existing
  conversations cache the tool list at connect time.
- `claude mcp list` and `claude mcp get thoughtspot-local` to verify the
  registration.
- `claude mcp remove thoughtspot-local` to unregister.

In the new conversation, `/mcp` should list your server and its tools. Then
just ask the agent to do something that needs your tool ("show me audit logs
for the last hour, only my org").

### 4b. MCP Inspector (great for ad-hoc exploration)

```bash
npx @modelcontextprotocol/inspector
```

In the UI:

- Transport: **Streamable HTTP**
- URL: `http://localhost:8787/token/mcp?api-version=latest`
- Header: `Authorization: Bearer <TS_TOKEN>@<ts-host>`
- Connect → **List Tools** → click your tool → fill in args → **Run**

Inspector handles the MCP `initialize` handshake automatically and shows
both raw JSON-RPC and structured output.

### 4c. curl (only if you must)

Streamable HTTP is **stateful** — every session must start with an
`initialize` call that returns an `Mcp-Session-Id` you echo on subsequent
requests. Two-step:

```bash
# 1. initialize, capture Mcp-Session-Id header
curl -i -X POST 'http://localhost:8787/token/mcp?api-version=latest' \
  -H "Authorization: Bearer <TOKEN>@<ts-host>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# 2. tools/list (or tools/call) with the session id
curl -s -X POST 'http://localhost:8787/token/mcp?api-version=latest' \
  -H "Authorization: Bearer <TOKEN>@<ts-host>" \
  -H "Mcp-Session-Id: <from step 1>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq
```

Use curl when you specifically need to see raw responses or are debugging
something Claude Code is hiding. For everyday work, Claude Code or Inspector
are faster.

---

## 5. Debugging cookbook — issues we've actually hit

### "Invalid URL: Invalid URL string." → 500

The bearer handler splits the auth header on `@`:

```ts
[accessToken, tsHost] = accessToken.split("@");
```

If your `<TS_HOST>` value contains `https://`, you get
`tsHost === "https:"` (because there are now multiple `@` segments and
destructuring only takes the first two) and `new URL("https://https:")`
throws.

**Fix:** strip the scheme — use `my-instance.thoughtspot.cloud`, not
`https://my-instance.thoughtspot.cloud`. Or split into two headers:

```
Authorization: Bearer <token>
x-ts-host: my-instance.thoughtspot.cloud
```

### `tools/call` returns 400 from curl

Streamable HTTP requires the `initialize` handshake — see §4c. A bare
`tools/list` without a prior init will 400.

### Tool not visible in Claude Code's `/mcp`

Run this checklist:

1. **Verify URL:** `claude mcp get thoughtspot-local` — must say
   `/token/mcp`, not `/bearer/mcp`. The latter only serves V1.
2. **New conversation:** existing sessions cache the tool list. Start a
   fresh conversation and run `/mcp` again.
3. **Server actually has the tool:** hit `tools/list` via curl (§4c) or
   Inspector. If the tool isn't there, the issue is server-side — check
   wrangler dev output for compile errors, and confirm your descriptor is
   in `toolDefinitionsV2`, not lost in `toolDefinitionsV1` or stranded
   outside both arrays.
4. **Hard reset:** `claude mcp remove …` then `claude mcp add …` again.

### `'result' is of type 'unknown'`

You forgot to annotate the service method's return type or pass an explicit
generic to `observeUpstreamCall`:

```ts
//  Bad
async getX(...) {
  return this.observeUpstreamCall(OP, () => (this.client as any).getX(...));
}

//  Good
async getX(...): Promise<XResponse> {
  return this.observeUpstreamCall<XResponse>(
    OP, () => (this.client as any).getX(...),
  );
}
```

### Stray autocomplete imports break the build

IDE autocomplete loves to pull in `import { tr } from "zod/v4/locales";`
when you type `tr…` inside a `try` block. Watch your imports — if the build
suddenly explodes after an edit, scan the top of the file for unexpected
new imports.

### Honeycomb `OTLPExporterError: 401` spam in dev

Cosmetic. OpenTelemetry is trying to ship spans to Honeycomb without an
API key. Either ignore it or set `HONEYCOMB_API_KEY` to a no-op string in
your dev env. It does not affect tool behaviour.

### Upstream returns data in a wrapper shape you didn't expect

Real example: TS audit logs come back as
`[{ date: "<iso>", log: "<JSON-encoded payload>" }]`. If you map straight
from the outer record, almost every field is `undefined`. Always inspect
one raw record from upstream (drop a `console.log(rawLogs[0])` in the
client handler temporarily) before you trust your assumed shape — then
do the JSON-parse / projection in `thoughtspot-client.ts`, not in the tool
handler.

### Wrangler hot-reload doesn't pick up some change

Wrangler watches `src/**` by default. Changes to `package.json`,
`wrangler.jsonc`, env vars, or files in `node_modules` need a manual
restart (`Ctrl+C` then `npm run dev`). Schema changes inside Zod / TS
files always hot-reload.

---

## 6. Conventions and patterns

- **Snake_case at the agent boundary, camelCase internally.** Schema field
  names are `start_epoch_ms`, service params are `startEpochMs`. The tool
  handler maps between them.
- **Span every layer.** Decorate handlers with `@WithSpan("name")` and set
  contextual attributes via `getActiveSpan()?.setAttribute(...)`. The naming
  convention is `call-<tool>` at the MCP layer, `<verb>-<noun>` at the
  service layer.
- **Don't log PII / secrets.** No bearer tokens in `console.log`, no
  user-identifying fields in error messages returned to the agent. Server-
  side logs may include them when strictly needed, but think before you
  print.
- **Fail with a useful agent-facing message.** The first arg of
  `createErrorResponse` is what the agent (and ultimately the user) sees —
  it should tell them how to recover ("widen the time window", "ask an
  admin"), not just "Error".
- **No silent fallbacks.** If an upstream error means the result is wrong
  (vs missing), surface it. `getRelevantQuestions` returning the raw query
  as a fallback is a deliberate exception, not a default.

---

## 7. Security checklist before merging

- [ ] Inputs validated by Zod schema; numeric bounds reasonable.
- [ ] Privilege gating via `sessionInfo.privileges` when the tool exposes
      sensitive data or destructive actions. Server-side only; never
      trust agent-supplied "I'm an admin" claims.
- [ ] Error messages to the agent are generic (no stack traces, internal
      paths, or upstream error bodies).
- [ ] No PII or secrets in `console.log` / structured logs.
- [ ] No new dependencies added; reuse existing libs (`hono`, `zod`,
      `@thoughtspot/rest-api-sdk`).
- [ ] If a new external endpoint is called, the URL is constructed from
      `instanceUrl` (never user-supplied), and the request uses bearer
      auth, not any weaker scheme.
- [ ] Tests cover the auth gate (positive + negative) and one error path.

---

## 8. Worked example index

The `get_audit_logs` tool exercises every step above. To trace through it
end-to-end:

- Schemas + descriptor: `src/servers/tool-definitions.ts` — search for
  `GetAuditLogs`.
- Service method: `src/thoughtspot/thoughtspot-service.ts` —
  `getAuditLogs`.
- Custom client handler (SDK doesn't expose the endpoint):
  `src/thoughtspot/thoughtspot-client.ts` — `addGetAuditLogs`.
- Tool handler with admin gate: `src/servers/mcp-server.ts` —
  `callGetAuditLogs`.
- Tests: `test/servers/mcp-server.spec.ts` — `describe("Get Audit Logs Tool")`.

When in doubt, copy the pattern from there.

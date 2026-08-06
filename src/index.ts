import {
	type ResolveConfigFn,
	type TraceConfig,
	instrument,
} from "@microlabs/otel-cf-workers";
import { trace } from "@opentelemetry/api";
import { type AuthHooks, createOAuthHandler } from "@thoughtspot/mcp-auth";

import { instrumentedMCPServer } from "./cloudflare-utils";
import {
	getStatusClass,
	resolveRequestMetricContext,
} from "./metrics/runtime/metric-context";
import {
	type ApiVersionMode,
	METRIC_NAMES,
} from "./metrics/runtime/metric-types";
import {
	getMetricsRecorderFromExecutionContext,
	normalizeRequestedApiVersionForAnalytics,
	recordBearerAuthRequestMetric,
	recordHttpRequestMetrics,
	recordStatusMetric,
	resolveRequestedApiVersionMode,
	withRequestMetrics,
} from "./metrics/runtime/request-metrics";
import { ConversationStorageServerSQLite } from "./servers/conversation-storage-server";
import { MCPServer } from "./servers/mcp-server";
import { UserTokenStoreSQLite } from "./servers/user-token-store-server";
import { type Props, normalizeClientName } from "./utils";

export { ConversationStorageServerSQLite, UserTokenStoreSQLite };

// OTEL configuration function
const config: ResolveConfigFn = (env: Env, _trigger) => {
	return {
		exporter: {
			url: "https://api.honeycomb.io/v1/traces",
			headers: { "x-honeycomb-team": process.env.HONEYCOMB_API_KEY },
		},
		service: { name: process.env.HONEYCOMB_DATASET },
	} as TraceConfig;
};

// Create the instrumented ThoughtSpotMCP for the main export
export const ThoughtSpotMCP = instrumentedMCPServer(MCPServer, config);

const METRIC_NAME_MAP = {
	oauth_authorize_requests_total: METRIC_NAMES.oauthAuthorizeRequestsTotal,
	oauth_authorize_submit_total: METRIC_NAMES.oauthAuthorizeSubmitTotal,
	oauth_callback_total: METRIC_NAMES.oauthCallbackTotal,
	oauth_store_token_total: METRIC_NAMES.oauthStoreTokenTotal,
} as const;

const hooks: AuthHooks<Props> = {
	onAuthMetric(name, status, ctx, req) {
		const requestContext = resolveRequestMetricContext(req);
		recordStatusMetric(
			getMetricsRecorderFromExecutionContext(ctx),
			METRIC_NAME_MAP[name],
			status,
			{
				route_group: requestContext.routeGroup,
				transport: requestContext.transport,
				auth_mode: requestContext.authMode,
				api_surface: requestContext.apiSurface,
				status_class: getStatusClass(status),
			},
		);
	},
	onBearerMetric(status, ctx, req, group) {
		recordBearerAuthRequestMetric(
			getMetricsRecorderFromExecutionContext(ctx),
			req,
			status,
			group,
		);
	},
	// Carry the gettoken fields the keep-warm refresh needs into the OAuth grant,
	// so they're on every later request (only available at token-exchange time).
	extendGrantProps(token, base): Props {
		return {
			...(base as Props),
			globalRefreshToken: token?.data?.refreshToken,
			globalTokenCreatedAt: token?.data?.tokenCreatedTime,
			globalTokenExpiresAt: token?.data?.tokenExpiryDuration,
		};
	},
	extendProps(req, base): Props {
		// Bearer/token flow: stamp api-version metadata from query params.
		// /bearer/* path family uses backwards-compat default; /token/* uses requested/latest.
		const url = new URL(req.url);
		const requestedApiVersion = url.searchParams.get("api-version");
		const isBearerLegacy = url.pathname.includes("/bearer/");

		const props: Props = {
			...base,
			clientName: normalizeClientName(base.clientName),
			// Static-token auth. /bearer/* is legacy "bearer"; /token/* is "token".
			// Gates OAuth-only tools (e.g. list_orgs) off for these.
			authMode: isBearerLegacy ? "bearer" : "token",
		};

		let apiVersion: string | undefined;
		let apiVersionMode: ApiVersionMode | undefined;

		if (isBearerLegacy) {
			apiVersion = "backwards-compatibility-default";
			apiVersionMode = "implicit_legacy";
		} else if (requestedApiVersion) {
			apiVersion = requestedApiVersion;
			apiVersionMode = resolveRequestedApiVersionMode(requestedApiVersion);
		} else {
			apiVersion = "latest";
			apiVersionMode = "implicit_latest";
		}

		if (requestedApiVersion) {
			props.apiRequestedVersion =
				normalizeRequestedApiVersionForAnalytics(requestedApiVersion);
		}
		props.apiVersion = apiVersion;
		props.apiVersionMode = apiVersionMode;

		const enableRawSessionUpdates =
			url.searchParams.get("enable-raw-session-updates") === "true";
		props.enableRawSessionUpdates = enableRawSessionUpdates;

		return props;
	},
};

const oauthFetchHandler = createOAuthHandler<Props>({
	serverInfo: {
		name: "ThoughtSpot Spotter",
		logo: "https://avatars.githubusercontent.com/u/8906680?s=200&v=4",
		description: "MCP Server for ThoughtSpot Agent",
	},
	mcpServerClass: ThoughtSpotMCP,
	hooks,
	enrichMcpRequestProps(request, _ctx, baseProps): Props {
		// OAuth-authenticated /mcp + /sse: derive apiVersion from query params,
		// defaulting to legacy for backwards compatibility (matches prior behaviour).
		const url = new URL(request.url);
		const requestedApiVersion = url.searchParams.get("api-version");
		let apiVersion = requestedApiVersion;
		let apiVersionMode: ApiVersionMode;

		if (!apiVersion) {
			apiVersion = "backwards-compatibility-default";
			apiVersionMode = "implicit_legacy";
		} else {
			apiVersionMode = resolveRequestedApiVersionMode(apiVersion);
		}

		const enableRawSessionUpdates =
			url.searchParams.get("enable-raw-session-updates") === "true";

		return {
			...(baseProps as Props),
			clientName: normalizeClientName(baseProps.clientName),
			apiVersion,
			apiRequestedVersion: requestedApiVersion
				? normalizeRequestedApiVersionForAnalytics(requestedApiVersion)
				: undefined,
			apiVersionMode,
			// OAuth-authenticated flow; enables the OAuth-only org tools.
			authMode: "oauth",
			enableRawSessionUpdates,
		};
	},
	// Extra routes mounted on the default handler app (consumer-specific).
	extraRoutes(app) {
		app.get("/", async (c) => {
			if (!c.env.ASSETS) {
				console.error("ASSETS binding is not configured");
				return c.text("Internal Server Error", 500);
			}
			return c.env.ASSETS.fetch("/index.html");
		});
		app.get("/.well-known/openai-apps-challenge", (c) => {
			return c.text(c.env.OPEN_AI_TOKEN as string);
		});
	},
});

// Wrap with OTel + tracing attributes.
const oauthHandler = {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const span = trace.getActiveSpan();
		if (span) {
			span.setAttributes({
				component: "OAuthProvider",
				request_url: request.url,
				request_method: request.method,
			});
		}
		return oauthFetchHandler.fetch!(request as any, env, ctx);
	},
};

const instrumentedOAuthHandler = instrument(oauthHandler, config);

// OTEL instrumentation automatically uses or passing along some headers from upstream calls, so we
// need to strip them from the request before OTEL sees them if we don't want that to happen
const HEADERS_TO_STRIP = ["traceparent", "tracestate"];

// Temporary path aliases for clients that can't send a query string (some
// hosts mishandle the "?" in the connection URL). A request to
// `<base>-<version>` is rewritten to `<base>?api-version=<version>` before
// routing/metrics see it.
// TODO: Remove once affected clients support query params.
const ALIASABLE_MCP_PATHS = ["/mcp", "/token/mcp"] as const;

function applyPathAlias(
	request: Request<unknown, IncomingRequestCfProperties<unknown>>,
): Request<unknown, IncomingRequestCfProperties<unknown>> {
	const url = new URL(request.url);
	for (const base of ALIASABLE_MCP_PATHS) {
		const prefix = `${base}-`;
		if (!url.pathname.startsWith(prefix)) {
			continue;
		}
		const version = url.pathname.slice(prefix.length);
		if (!version) {
			continue;
		}
		url.pathname = base;
		url.searchParams.set("api-version", version);
		return new Request(url.toString(), request) as Request<
			unknown,
			IncomingRequestCfProperties<unknown>
		>;
	}
	return request;
}

export default {
	async fetch(
		request: Request<unknown, IncomingRequestCfProperties<unknown>>,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		if (HEADERS_TO_STRIP.some((header) => request.headers.has(header))) {
			const headers = new Headers(request.headers);
			HEADERS_TO_STRIP.forEach((header) => headers.delete(header));
			request = new Request(request, { headers });
		}

		request = applyPathAlias(request);

		return withRequestMetrics(
			env as unknown as Record<string, unknown>,
			ctx,
			async (recorder) => {
				const requestStartMs = Date.now();

				try {
					const response = await instrumentedOAuthHandler.fetch!(
						request,
						env,
						ctx,
					);
					recordHttpRequestMetrics(
						recorder,
						request,
						response,
						ctx,
						Date.now() - requestStartMs,
					);
					return response;
				} catch (error) {
					recordHttpRequestMetrics(
						recorder,
						request,
						new Response(null, { status: 500 }),
						ctx,
						Date.now() - requestStartMs,
					);
					throw error;
				}
			},
		);
	},
};

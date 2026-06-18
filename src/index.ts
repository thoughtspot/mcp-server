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
import type { Props } from "./utils";

export { ConversationStorageServerSQLite };

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
	extendProps(req, base): Props {
		// Bearer/token flow: stamp api-version metadata from query params.
		// /bearer/* path family uses backwards-compat default; /token/* uses requested/latest.
		const url = new URL(req.url);
		const requestedApiVersion = url.searchParams.get("api-version");
		const isBearerLegacy = url.pathname.includes("/bearer/");

		const props: Props = {
			...base,
			clientName: (base.clientName ?? {
				clientId: "Bearer Token client",
				clientName: "Bearer Token client",
				registrationDate: Date.now(),
			}) as Props["clientName"],
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

		return props;
	},
};

const oauthFetchHandler = createOAuthHandler<Props>({
	serverInfo: {
		name: "ThoughtSpot Spotter",
		logo: "https://avatars.githubusercontent.com/u/8906680?s=200&v=4",
		description: "MCP Server for ThoughtSpot Agent",
	},
	mcpServerClass: ThoughtSpotMCP as unknown as Parameters<
		typeof createOAuthHandler
	>[0]["mcpServerClass"],
	// Cast needed: pkg AuthHooks<BaseProps> has a narrower clientName than local Props.
	hooks: hooks as any,
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

		return {
			...(baseProps as Props),
			apiVersion,
			apiRequestedVersion: requestedApiVersion
				? normalizeRequestedApiVersionForAnalytics(requestedApiVersion)
				: undefined,
			apiVersionMode,
		};
	},
	// Extra routes mounted on the default handler app (consumer-specific).
	extraRoutes(app) {
		app.get("/", async (c) => {
			return c.env.ASSETS!.fetch("/index.html");
		});
		app.get("/hello", (c) => c.json({ message: "Hello, World!" }));
		app.get("/.well-known/openai-apps-challenge", (c) => {
			return c.text(process.env.OPEN_AI_TOKEN as string);
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
				instance_url: (ctx as any).props?.instanceUrl || "unknown",
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

import type {
	AuthRequest,
	OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { type Span, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { Hono } from "hono";
import { decodeBase64Url, encodeBase64Url } from "hono/utils/encode";
import { any } from "zod";
import {
	getStatusClass,
	resolveRequestMetricContext,
} from "./metrics/runtime/metric-context";
import { METRIC_NAMES } from "./metrics/runtime/metric-types";
import {
	getMetricsRecorderFromExecutionContext,
	recordStatusMetric,
} from "./metrics/runtime/request-metrics";
import { WithSpan, getActiveSpan } from "./metrics/tracing/tracing-utils";
import {
	buildSamlRedirectUrl,
	parseRedirectApproval,
	renderApprovalDialog,
} from "./oauth-manager/oauth-utils";
import { renderTokenCallback } from "./oauth-manager/token-utils";
import { PUBLIC_ROUTES } from "./routes";
import type { Props } from "./utils";
import { McpServerError } from "./utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

function getExecutionContextOrUndefined(context: {
	executionCtx: ExecutionContext;
}): ExecutionContext | undefined {
	try {
		return context.executionCtx;
	} catch {
		return undefined;
	}
}

function recordAuthFlowMetric(
	context: { executionCtx: ExecutionContext; req: { raw: Request } },
	name:
		| typeof METRIC_NAMES.oauthAuthorizeRequestsTotal
		| typeof METRIC_NAMES.oauthAuthorizeSubmitTotal
		| typeof METRIC_NAMES.oauthCallbackTotal
		| typeof METRIC_NAMES.oauthStoreTokenTotal,
	status: number,
): void {
	const executionContext = getExecutionContextOrUndefined(context);
	if (!executionContext) {
		return;
	}

	const requestContext = resolveRequestMetricContext(context.req.raw);
	recordStatusMetric(
		getMetricsRecorderFromExecutionContext(executionContext),
		name,
		status,
		{
			route_group: requestContext.routeGroup,
			transport: requestContext.transport,
			auth_mode: requestContext.authMode,
			api_surface: requestContext.apiSurface,
			status_class: getStatusClass(status),
		},
	);
}

class Handler {
	@WithSpan("serve-index")
	async serveIndex(env: Env) {
		return env.ASSETS.fetch("/index.html");
	}

	@WithSpan("hello-world")
	async helloWorld() {
		return { message: "Hello, World!" };
	}

	@WithSpan("authorize-get")
	async getAuthorize(request: Request, oauthProvider: OAuthHelpers) {
		const span = getActiveSpan();
		const oauthReqInfo = await oauthProvider.parseAuthRequest(request);
		const { clientId } = oauthReqInfo;

		span?.setAttribute("client_id", clientId || "unknown");
		if (!clientId) {
			throw new McpServerError({ message: "Missing client ID" }, 400);
		}
		if (!oauthReqInfo.codeChallenge) {
			throw new McpServerError(
				{ message: "PKCE is required: missing code challenge" },
				400,
			);
		}
		if (oauthReqInfo.codeChallengeMethod !== "S256") {
			throw new McpServerError(
				{ message: "PKCE code challenge method must be S256" },
				400,
			);
		}
		const client = await oauthProvider.lookupClient(clientId);
		return renderApprovalDialog(request, {
			client,
			server: {
				name: "ThoughtSpot MCP Server",
				logo: "https://avatars.githubusercontent.com/u/8906680?s=200&v=4",
				description: "MCP Server for ThoughtSpot Agent",
			},
			state: { oauthReqInfo },
		});
	}

	@WithSpan("authorize-post")
	async postAuthorize(request: Request, requestUrl: string) {
		const span = getActiveSpan();
		try {
			const { state, instanceUrl } = await parseRedirectApproval(request);

			span?.setAttribute("instance_url", instanceUrl || "unknown");

			if (!state.oauthReqInfo) {
				throw new McpServerError(
					{ message: "Missing OAuth request info" },
					400,
				);
			}

			if (!instanceUrl) {
				throw new McpServerError({ message: "Missing instance URL" }, 400);
			}

			const origin = new URL(requestUrl).origin;

			// TODO: Remove this once we have a proper way to handle this
			// This is a temporary fix to handle the case where the instance URL is a free trial instance URL
			// Since, free trial does not support IAMv2, we will assume that the user is logged in.
			if (
				instanceUrl.match(/^https:\/\/(?:team|my)\d+\.thoughtspot\.cloud\/?$/)
			) {
				const callbackUrl = new URL("/callback", origin);
				callbackUrl.searchParams.set("instanceUrl", instanceUrl);
				callbackUrl.searchParams.set(
					"oauthReqInfo",
					encodeBase64Url(
						new TextEncoder().encode(JSON.stringify(state.oauthReqInfo)).buffer,
					),
				);
				return callbackUrl.toString();
			}

			const redirectUrl = buildSamlRedirectUrl(
				instanceUrl,
				state.oauthReqInfo,
				origin,
			);

			console.log("redirectUrl", redirectUrl);

			return redirectUrl;
		} catch (error) {
			throw new McpServerError(error, 500);
		}
	}

	@WithSpan("oauth-callback")
	async handleCallback(request: Request, assets: any, requestUrl: string) {
		const span = getActiveSpan();

		const url = new URL(request.url);
		const instanceUrl = url.searchParams.get("instanceUrl");
		const encodedOauthReqInfo = url.searchParams
			.get("oauthReqInfo")
			// Added as a workaround for https://thoughtspot.atlassian.net/browse/SCAL-258056
			?.replace("/10023.html", "");

		span?.setAttributes({
			instance_url: instanceUrl || "unknown",
			has_oauth_req_info: !!encodedOauthReqInfo,
		});

		if (!instanceUrl) {
			throw new McpServerError({ message: "Missing instance URL" }, 400);
		}
		if (!encodedOauthReqInfo) {
			throw new McpServerError({ message: "Missing OAuth request info" }, 400);
		}

		let decodedOAuthReqInfo: any;
		try {
			decodedOAuthReqInfo = JSON.parse(
				new TextDecoder().decode(decodeBase64Url(encodedOauthReqInfo)),
			);
		} catch (error) {
			throw new McpServerError(
				{ message: "Invalid OAuth request info format", details: error },
				400,
			);
		}
		const origin = new URL(requestUrl).origin;
		try {
			const htmlContent = await renderTokenCallback(
				instanceUrl,
				decodedOAuthReqInfo,
				assets,
				origin,
			);
			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "Token callback rendered successfully",
			});
			return htmlContent;
		} catch (error) {
			throw new McpServerError(
				{ message: "Error rendering token callback", details: error },
				500,
			);
		}
	}

	@WithSpan("store-token")
	async storeToken(request: Request, oauthProvider: OAuthHelpers) {
		const span = getActiveSpan();

		let token: any;
		let oauthReqInfo: any;
		let instanceUrl: string;

		try {
			const body = (await request.json()) as any;
			token = body.token;
			oauthReqInfo = body.oauthReqInfo;
			instanceUrl = body.instanceUrl;
		} catch (error) {
			throw new McpServerError(
				{ message: "Invalid JSON format", details: error },
				400,
			);
		}
		span?.setAttributes({
			instance_url: instanceUrl || "unknown",
			has_token: !!token,
			has_oauth_req_info: !!oauthReqInfo,
		});

		if (!token || !oauthReqInfo || !instanceUrl) {
			throw new McpServerError(
				{ message: "Missing token or OAuth request info or instanceUrl" },
				400,
			);
		}

		const { clientId } = oauthReqInfo;
		span?.setAttribute("client_id", clientId || "unknown");

		const clientName = await oauthProvider.lookupClient(clientId);

		span?.addEvent("complete-authorization");
		// Complete the authorization with the provided information
		const { redirectTo } = await oauthProvider.completeAuthorization({
			request: oauthReqInfo,
			userId: "default", // Using a default user ID since username is not required
			metadata: {
				label: "default",
			},
			scope: oauthReqInfo.scope,
			props: {
				accessToken: token.data.token,
				instanceUrl: instanceUrl,
				clientName: clientName,
			} as Props,
		});

		span?.setStatus({
			code: SpanStatusCode.OK,
			message: "Token stored successfully",
		});

		return { redirectTo };
	}
}

const handler = new Handler();

app.get(PUBLIC_ROUTES.root, async (c) => {
	const response = await handler.serveIndex(c.env);
	return response;
});

app.get(PUBLIC_ROUTES.hello, async (c) => {
	const result = await handler.helloWorld();
	return c.json(result);
});

app.get(PUBLIC_ROUTES.authorize, async (c) => {
	try {
		const response = await handler.getAuthorize(
			c.req.raw,
			c.env.OAUTH_PROVIDER,
		);
		recordAuthFlowMetric(
			c,
			METRIC_NAMES.oauthAuthorizeRequestsTotal,
			response.status,
		);
		return response;
	} catch (error) {
		const response = c.text(`Internal Server Error ${error}`, 500);
		recordAuthFlowMetric(
			c,
			METRIC_NAMES.oauthAuthorizeRequestsTotal,
			response.status,
		);
		return response;
	}
});

app.post(PUBLIC_ROUTES.authorize, async (c) => {
	try {
		const redirectUrl = await handler.postAuthorize(c.req.raw, c.req.url);
		const response = Response.redirect(redirectUrl);
		recordAuthFlowMetric(
			c,
			METRIC_NAMES.oauthAuthorizeSubmitTotal,
			response.status,
		);
		return response;
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("Missing instance URL")
		) {
			const response = new Response("Missing instance URL", { status: 400 });
			recordAuthFlowMetric(
				c,
				METRIC_NAMES.oauthAuthorizeSubmitTotal,
				response.status,
			);
			return response;
		}
		const response = new Response(`Internal Server Error ${error}`, {
			status: 500,
		});
		recordAuthFlowMetric(
			c,
			METRIC_NAMES.oauthAuthorizeSubmitTotal,
			response.status,
		);
		return response;
	}
});

app.get(PUBLIC_ROUTES.callback, async (c) => {
	try {
		const htmlContent = await handler.handleCallback(
			c.req.raw,
			c.env.ASSETS,
			c.req.url,
		);
		const response = new Response(htmlContent, {
			headers: {
				"Content-Type": "text/html",
			},
		});
		recordAuthFlowMetric(c, METRIC_NAMES.oauthCallbackTotal, response.status);
		return response;
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes("Missing instance URL")) {
				const response = c.text(`Missing instance URL ${error}`, 400);
				recordAuthFlowMetric(
					c,
					METRIC_NAMES.oauthCallbackTotal,
					response.status,
				);
				return response;
			}
			if (error.message.includes("Missing OAuth request info")) {
				const response = c.text(`Missing OAuth request info ${error}`, 400);
				recordAuthFlowMetric(
					c,
					METRIC_NAMES.oauthCallbackTotal,
					response.status,
				);
				return response;
			}
			if (error.message.includes("Invalid OAuth request info format")) {
				const response = c.text(
					`Invalid OAuth request info format ${error}`,
					400,
				);
				recordAuthFlowMetric(
					c,
					METRIC_NAMES.oauthCallbackTotal,
					response.status,
				);
				return response;
			}
		}
		const response = c.text(`Internal server error ${error}`, 500);
		recordAuthFlowMetric(c, METRIC_NAMES.oauthCallbackTotal, response.status);
		return response;
	}
});

app.post(PUBLIC_ROUTES.storeToken, async (c) => {
	try {
		const result = await handler.storeToken(c.req.raw, c.env.OAUTH_PROVIDER);
		const response = new Response(JSON.stringify(result), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
			},
		});
		recordAuthFlowMetric(c, METRIC_NAMES.oauthStoreTokenTotal, response.status);
		return response;
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes("Invalid JSON format")) {
				const response = c.text(`Invalid JSON format ${error}`, 400);
				recordAuthFlowMetric(
					c,
					METRIC_NAMES.oauthStoreTokenTotal,
					response.status,
				);
				return response;
			}
			if (
				error.message.includes(
					"Missing token or OAuth request info or instanceUrl",
				)
			) {
				const response = c.text(
					`Missing token or OAuth request info or instanceUrl ${error}`,
					400,
				);
				recordAuthFlowMetric(
					c,
					METRIC_NAMES.oauthStoreTokenTotal,
					response.status,
				);
				return response;
			}
		}
		const response = c.text(`Internal server error ${error}`, 500);
		recordAuthFlowMetric(c, METRIC_NAMES.oauthStoreTokenTotal, response.status);
		return response;
	}
});

app.get(PUBLIC_ROUTES.openaiAppsChallenge, (c) => {
	return c.text(process.env.OPEN_AI_TOKEN);
});

export default app;

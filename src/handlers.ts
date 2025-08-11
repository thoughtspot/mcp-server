import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import type { Props } from './utils';
import { getFromKV, McpServerError } from './utils';
import { parseRedirectApproval, renderApprovalDialog, buildSamlRedirectUrl } from './oauth-manager/oauth-utils';
import { renderTokenCallback } from './oauth-manager/token-utils';
import { encodeBase64Url, decodeBase64Url } from 'hono/utils/encode';
import { getActiveSpan, WithSpan } from './metrics/tracing/tracing-utils';
import { SpanStatusCode } from "@opentelemetry/api";
import { ThoughtSpotService } from './thoughtspot/thoughtspot-service';
import { getThoughtSpotClient } from './thoughtspot/thoughtspot-client';

/**
 * Uniform response structure for all handlers
 * 
 * Success Response Example:
 * {
 *   "success": true,
 *   "statusCode": 200,
 *   "timestamp": "2023-12-07T10:30:00.000Z",
 *   "data": { ... },
 *   "message": "Operation completed successfully"
 * }
 * 
 * Error Response Example:
 * {
 *   "success": false,
 *   "statusCode": 400,
 *   "timestamp": "2023-12-07T10:30:00.000Z",
 *   "error": {
 *     "code": "BAD_REQUEST",
 *     "message": "Invalid input provided",
 *     "details": { ... }
 *   }
 * }
 */
interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
        details?: any;
    };
    message?: string;
    statusCode: number;
    timestamp: string;
}


/**
 * Create a uniform API response structure
 */
function createApiResponse<T = any>(
    success: boolean,
    statusCode: number,
    data?: T,
    message?: string,
    errorCode?: string,
    errorMessage?: string,
    errorDetails?: any,
    spanMessage?: string
): Response {
    const span = getActiveSpan();
    
    if (success) {
        span?.setStatus({ 
            code: SpanStatusCode.OK, 
            message: spanMessage || message || 'Request completed successfully'
        });
    } else {
        span?.setStatus({ 
            code: SpanStatusCode.ERROR, 
            message: spanMessage || errorMessage || 'Request failed'
        });
    }

    const response: ApiResponse<T> = {
        success,
        statusCode,
        timestamp: new Date().toISOString(),
        ...(data !== undefined && { data }),
        ...(message && { message }),
        ...(!success && {
            error: {
                code: errorCode || 'UNKNOWN_ERROR',
                message: errorMessage || 'An error occurred',
                ...(errorDetails && { details: errorDetails })
            }
        })
    };

    return new Response(JSON.stringify(response), {
        status: statusCode,
        headers: {
            'Content-Type': 'application/json'
        }
    });
}

/**
 * Create a standardized success response
 */
function createSuccessResponse<T = any>(
    data?: T, 
    message?: string, 
    statusCode = 200,
    spanMessage?: string
): Response {
    return createApiResponse(
        true,
        statusCode,
        data,
        message,
        undefined,
        undefined,
        undefined,
        spanMessage
    );
}

/**
 * Create a standardized error response
 */
function createErrorResponse(
    errorMessage: string,
    statusCode = 500,
    errorCode?: string,
    errorDetails?: any,
    spanMessage?: string
): Response {
    return createApiResponse(
        false,
        statusCode,
        undefined,
        undefined,
        errorCode || getErrorCodeFromStatus(statusCode),
        errorMessage,
        errorDetails,
        spanMessage
    );
}

/**
 * Get error code based on HTTP status code
 */
function getErrorCodeFromStatus(statusCode: number): string {
    switch (statusCode) {
        case 400: return 'BAD_REQUEST';
        case 401: return 'UNAUTHORIZED';
        case 403: return 'FORBIDDEN';
        case 404: return 'NOT_FOUND';
        case 409: return 'CONFLICT';
        case 422: return 'UNPROCESSABLE_ENTITY';
        case 500: return 'INTERNAL_SERVER_ERROR';
        case 502: return 'BAD_GATEWAY';
        case 503: return 'SERVICE_UNAVAILABLE';
        default: return 'UNKNOWN_ERROR';
    }
}

/**
 * Create an HTML response (special case for OAuth flows)
 */
function createHtmlResponse(
    htmlContent: string, 
    statusCode = 200,
    spanMessage?: string
): Response {
    const span = getActiveSpan();
    span?.setStatus({ 
        code: SpanStatusCode.OK, 
        message: spanMessage || 'HTML response created successfully'
    });

    return new Response(htmlContent, {
        status: statusCode,
        headers: {
            'Content-Type': 'text/html'
        }
    });
}

/**
 * Create a redirect response (special case for OAuth flows)
 */
function createRedirectResponse(
    redirectUrl: string, 
    statusCode = 302,
    spanMessage?: string
): Response {
    const span = getActiveSpan();
    span?.setStatus({ 
        code: SpanStatusCode.OK, 
        message: spanMessage || `Redirecting to ${redirectUrl}`
    });

    return Response.redirect(redirectUrl, statusCode);
}

/**
 * Create a binary response (for images, files, etc.)
 */
function createBinaryResponse(
    data: ArrayBuffer, 
    contentType: string,
    statusCode = 200,
    spanMessage?: string
): Response {
    const span = getActiveSpan();
    span?.setStatus({ 
        code: SpanStatusCode.OK, 
        message: spanMessage || `Binary response created: ${contentType}`
    });

    return new Response(data, {
        status: statusCode,
        headers: {
            'Content-Type': contentType
        }
    });
}

/**
 * Handle McpServerError and create uniform response
 */
function handleMcpServerError(error: McpServerError): Response {
    return createErrorResponse(
        error.message,
        error.statusCode,
        'MCP_SERVER_ERROR',
        error.errorJson,
        `McpServerError: ${error.message}`
    );
}

/**
 * Handle generic error and create uniform response
 */
function handleGenericError(
    error: any, 
    defaultMessage = 'Internal server error',
    defaultStatusCode = 500
): Response {
    const message = error instanceof Error ? error.message : defaultMessage;
    const statusCode = error?.statusCode || defaultStatusCode;
    
    return createErrorResponse(
        message,
        statusCode,
        'GENERIC_ERROR',
        error instanceof Error ? { stack: error.stack } : error,
        `Generic error: ${message}`
    );
}


const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>()

class Handler {
    @WithSpan('serve-index')
    async serveIndex(env: Env) {
        return env.ASSETS.fetch('/index.html');
    }

    @WithSpan('hello-world')
    async helloWorld() {
        return { message: "Hello, World!" };
    }

    @WithSpan('authorize-get')
    async getAuthorize(request: Request, oauthProvider: OAuthHelpers) {
        const span = getActiveSpan();
        const oauthReqInfo = await oauthProvider.parseAuthRequest(request);
        const { clientId } = oauthReqInfo;

        span?.setAttribute("client_id", clientId || "unknown");

        if (!clientId) {
            throw new McpServerError({ message: "Missing client ID" }, 400);
        }
        const client = await oauthProvider.lookupClient(clientId);
        return renderApprovalDialog(request, {
            client,
            server: {
                name: "ThoughtSpot MCP Server",
                logo: "https://avatars.githubusercontent.com/u/8906680?s=200&v=4",
                description: 'MCP Server for ThoughtSpot Agent',
            },
            state: { oauthReqInfo },
        });
    }

    @WithSpan('authorize-post')
    async postAuthorize(request: Request, requestUrl: string) {
        const span = getActiveSpan();
        try {
            const { state, instanceUrl } = await parseRedirectApproval(request);

            span?.setAttribute("instance_url", instanceUrl || "unknown");

            if (!state.oauthReqInfo) {
                throw new McpServerError({ message: "Missing OAuth request info" }, 400);
            }

            if (!instanceUrl) {
                throw new McpServerError({ message: "Missing instance URL" }, 400);
            }

            const origin = new URL(requestUrl).origin;

            // TODO: Remove this once we have a proper way to handle this
            // This is a temporary fix to handle the case where the instance URL is a free trial instance URL
            // Since, free trial does not support IAMv2, we will assume that the user is logged in.
            if (instanceUrl.match(/^https:\/\/(?:team|my)\d+\.thoughtspot\.cloud$/)) {
                const callbackUrl = new URL("/callback", origin);
                callbackUrl.searchParams.set("instanceUrl", instanceUrl);
                callbackUrl.searchParams.set(
                    "oauthReqInfo",
                    encodeBase64Url(new TextEncoder().encode(JSON.stringify(state.oauthReqInfo)).buffer)
                );
                return callbackUrl.toString();
            }

            const redirectUrl = buildSamlRedirectUrl(
                instanceUrl,
                state.oauthReqInfo,
                origin
            );

            console.log("redirectUrl", redirectUrl);

            return redirectUrl;
        } catch (error) {
            throw new McpServerError(error, 500);
        }
    }

    @WithSpan('oauth-callback')
    async handleCallback(request: Request, assets: any, requestUrl: string) {
        const span = getActiveSpan();

        const url = new URL(request.url);
        const instanceUrl = url.searchParams.get('instanceUrl');
        const encodedOauthReqInfo = url.searchParams.get('oauthReqInfo')
            // Added as a workaround for https://thoughtspot.atlassian.net/browse/SCAL-258056
            ?.replace('/10023.html', '');

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
            decodedOAuthReqInfo = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedOauthReqInfo)));
        } catch (error) {
            throw new McpServerError({ message: "Invalid OAuth request info format", details: error }, 400);
        }
        const origin = new URL(requestUrl).origin;
        try {
            const htmlContent = await renderTokenCallback(instanceUrl, decodedOAuthReqInfo, assets, origin);
            span?.setStatus({ code: SpanStatusCode.OK, message: "Token callback rendered successfully" });
            return htmlContent;
        } catch (error) {
            throw new McpServerError({ message: "Error rendering token callback", details: error }, 500);
        }
    }



    @WithSpan('store-token')
    async storeToken(request: Request, oauthProvider: OAuthHelpers) {
        const span = getActiveSpan();

        let token: any;
        let oauthReqInfo: any;
        let instanceUrl: string;

        try {
            const body = await request.json() as any;
            token = body.token;
            oauthReqInfo = body.oauthReqInfo;
            instanceUrl = body.instanceUrl;
        } catch (error) {
            throw new McpServerError({ message: "Invalid JSON format", details: error }, 400);
        }
        span?.setAttributes({
            instance_url: instanceUrl || "unknown",
            has_token: !!token,
            has_oauth_req_info: !!oauthReqInfo,
        });

        if (!token || !oauthReqInfo || !instanceUrl) {
            throw new McpServerError({ message: "Missing token or OAuth request info or instanceUrl" }, 400);
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
                hostName: (() => {
                    const host = request.headers.get('host') || 'http://localhost:8787';
                    if (host.startsWith('http://') || host.startsWith('https://')) {
                        return host;
                    }
                    return `https://${host}`;
                })(),
            } as Props,
        });

        span?.setStatus({ code: SpanStatusCode.OK, message: "Token stored successfully" });

        return { redirectTo };
    }

    @WithSpan('get-answer-image')
    async getAnswerImage(request: Request, env: Env) {
        const span = getActiveSpan();
        const url = new URL(request.url);
        const uniqueId = url.searchParams.get('uniqueId') || '';
        if (uniqueId === '') {
            return createErrorResponse("Unique ID parameter is required", 400, 'MISSING_UNIQUE_ID');
        }

        const sessionData = await getFromKV(uniqueId, env);
        if (!sessionData) {
            return createErrorResponse("Session data not found for the provided unique ID", 404, 'SESSION_NOT_FOUND');
        }        
        
        // Extract values from session data
        const { sessionId, generationNo, instanceURL, accessToken } = sessionData as any;
        
        if (!sessionId || !instanceURL || !accessToken) {
            return createErrorResponse("Invalid session data", 400, 'INVALID_SESSION_DATA');
        }
        
        const thoughtSpotService = new ThoughtSpotService(getThoughtSpotClient(instanceURL, accessToken));
        const image = await thoughtSpotService.getAnswerImagePNG(sessionId, generationNo);
        
        return createBinaryResponse(
            await image.arrayBuffer(), 
            'image/png',
            200,
            "Image fetched successfully"
        );
    }
}

const handler = new Handler();

app.get("/", async (c) => {
    const response = await handler.serveIndex(c.env);
    return response;
});

app.get("/hello", async (c) => {
    try {
        const result = await handler.helloWorld();
        return createSuccessResponse(result, "Hello world response generated successfully");
    } catch (error) {
        return handleGenericError(error, "Error generating hello world response");
    }
});


app.get("/authorize", async (c) => {
    try {
        const response = await handler.getAuthorize(c.req.raw, c.env.OAUTH_PROVIDER);
        return response;
    } catch (error) {
        if (error instanceof McpServerError) {
            return handleMcpServerError(error);
        }
        return handleGenericError(error, "Authorization error");
    }
});

app.post("/authorize", async (c) => {
    try {
        const redirectUrl = await handler.postAuthorize(c.req.raw, c.req.url);
        // OAuth flows require redirect responses, not JSON
            return createRedirectResponse(redirectUrl);
    } catch (error) {
        if (error instanceof McpServerError) {
            return handleMcpServerError(error);
        }
        return handleGenericError(error, "Authorization error");
    }
});

app.get("/callback", async (c) => {
    try {
        const htmlContent = await handler.handleCallback(c.req.raw, c.env.ASSETS, c.req.url);
        // OAuth callback returns HTML, so we keep the original response
        return createHtmlResponse(htmlContent, 200, "Callback handled successfully");
    } catch (error) {
        if (error instanceof McpServerError) {
            return handleMcpServerError(error);
        }
        return handleGenericError(error, "Callback handling error");
    }
});

app.post("/store-token", async (c) => {
    try {
        const result = await handler.storeToken(c.req.raw, c.env.OAUTH_PROVIDER);
        return createSuccessResponse(result, "Token stored successfully");
    } catch (error) {
        if (error instanceof McpServerError) {
            return handleMcpServerError(error);
        }
        return handleGenericError(error, "Token storage error");
    }
});

app.get("/data/img", async (c) => {
    try {
        return await handler.getAnswerImage(c.req.raw, c.env);
    } catch (error) {
        if (error instanceof McpServerError) {
            return handleMcpServerError(error);
        }
        return handleGenericError(error, "Image fetching error");
    }
});

export default app;
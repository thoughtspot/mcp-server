import { type Span, SpanStatusCode } from "@opentelemetry/api";
import {
	type BaseProps,
	McpServerError as PkgMcpServerError,
} from "@thoughtspot/mcp-auth";
import type { ApiVersionMode, AuthMode } from "./metrics/runtime/metric-types";
import { getActiveSpan } from "./metrics/tracing/tracing-utils";

export type Props = {
	accessToken: string;
	globalRefreshToken?: string;
	globalTokenCreatedAt?: number;
	globalTokenExpiresAt?: number;
	instanceUrl: string;
	clientName: {
		clientId: string;
		clientName: string;
		registrationDate: number;
	};
	apiVersion?: string;
	apiVersionMode?: ApiVersionMode;
	apiRequestedVersion?: string;
	authMode?: AuthMode;
	enableRawSessionUpdates?: boolean;
	// Undocumented URL flag (see index.ts): omit `iframe_url` from Analytics
	// Agent answers.
	suppressIframes?: boolean;
	// On by default; the undocumented `answer-widget=false` URL flag (see
	// index.ts) turns off the get_answer_image MCP Apps image card, the fallback
	// to show_answer.
	enableAnswerWidget?: boolean;
	// On by default; the undocumented `thoughtspot-ui=false` URL flag (see
	// index.ts) turns off the show_answer MCP Apps widget, which renders the full
	// ThoughtSpot UI inline via iframe srcdoc.
	enableThoughtSpotUiWidget?: boolean;
	// On by default; the undocumented `inline-charts=false` URL flag (see
	// index.ts) turns it off. In the show_answer widget, render charts in the
	// page (ThoughtSpot's same-origin chart mode) instead of in the hosted chart
	// iframe. Gives the page frame allow-same-origin.
	enableInlineCharts?: boolean;
	// Undocumented URL flag (see index.ts): in the show_answer widget, allow
	// the hosted chart iframe (*.pdom.thoughtspot.com) through the resource CSP's
	// frameDomains. Gives the page frame allow-same-origin.
	enableDirectChartIframe?: boolean;
	// Undocumented `relay-capture=true` URL flag (see index.ts): log each
	// thoughtspot_api_request as "[relay-capture] METHOD path ops status", to
	// collect the calls the view-only relay allowlist must cover. Local use.
	enableRelayCapture?: boolean;
	// Approach B prototype. Undocumented `embed-sdk=true` URL flag (see
	// index.ts): offer show_answer_embed, which frames the cluster with the
	// Visual Embed SDK and hands the widget a short-lived user token.
	enableEmbedSdkWidget?: boolean;
};

const DEFAULT_CLIENT_NAME = "Bearer Token client";

export function normalizeClientName(
	clientName: BaseProps["clientName"],
): Props["clientName"] {
	return {
		clientId: clientName?.clientId ?? DEFAULT_CLIENT_NAME,
		clientName: clientName?.clientName ?? DEFAULT_CLIENT_NAME,
		registrationDate:
			(clientName && "registrationDate" in clientName
				? clientName.registrationDate
				: undefined) ?? Date.now(),
	};
}

/**
 * Local McpServerError that wraps the base pkg error with OTel span
 * status/attribute side-effects (the pkg error is span-agnostic so it stays
 * portable across consumers that don't use OpenTelemetry).
 */
export class McpServerError extends PkgMcpServerError {
	public readonly span?: Span;

	constructor(errorJson: unknown, statusCode: number) {
		super(errorJson, statusCode);
		this.span = getActiveSpan();

		if (this.span) {
			this.span.setStatus({
				code: SpanStatusCode.ERROR,
				message: this.message,
			});
			this.span.recordException(this);
			if (typeof errorJson === "object" && errorJson !== null) {
				const obj = errorJson as Record<string, unknown>;
				if (obj.code) this.span.setAttribute("error.code", String(obj.code));
				if (obj.type) this.span.setAttribute("error.type", String(obj.type));
				if (obj.details) {
					this.span.setAttribute("error.details", JSON.stringify(obj.details));
				}
			}
			this.span.setAttribute("error.status_code", this.statusCode);
		}

		Object.setPrototypeOf(this, McpServerError.prototype);
	}
}

/**
 * Store a value in Cloudflare KV
 */
export async function putInKV(
	key: string,
	value: any,
	env?: any,
): Promise<void> {
	if (!env?.OAUTH_KV) {
		return;
	}
	try {
		await env.OAUTH_KV.put(key, JSON.stringify(value), {
			expirationTtl: 60 * 60 * 3,
		});
	} catch (error) {
		console.error("Error storing in KV:", error);
	}
}

/**
 * Retrieve a value from Cloudflare KV
 */
export async function getFromKV(key: string, env?: any): Promise<any> {
	if (!env?.OAUTH_KV) {
		return undefined;
	}

	try {
		const value = await env.OAUTH_KV.get(key, { type: "json" });
		return value;
	} catch (error) {
		console.error("Error retrieving from KV:", error);
		return undefined;
	}
}

export const capitalize = (s: string): string => {
	if (!s) return "";
	return s.charAt(0).toUpperCase() + s.slice(1);
};

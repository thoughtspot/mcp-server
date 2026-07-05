import { type Span, SpanStatusCode } from "@opentelemetry/api";
import {
	type BaseProps,
	McpServerError as PkgMcpServerError,
} from "@thoughtspot/mcp-auth";
import type { ApiVersionMode } from "./metrics/runtime/metric-types";
import { getActiveSpan } from "./metrics/tracing/tracing-utils";

export type Props = {
	accessToken: string;
	instanceUrl: string;
	clientName: {
		clientId: string;
		clientName: string;
		registrationDate: number;
	};
	apiVersion?: string;
	apiVersionMode?: ApiVersionMode;
	apiRequestedVersion?: string;
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

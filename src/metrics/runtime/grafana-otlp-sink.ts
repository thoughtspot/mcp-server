import {
	HISTOGRAM_BUCKETS_MS,
	type MetricKind,
	type MetricLabelValue,
	type MetricName,
} from "./metric-types";
import type {
	MetricObservation,
	MetricResourceAttributes,
	MetricsFlushPayload,
	MetricsSink,
} from "./metrics-sink";

type OtlpStringValue = { stringValue: string };
type OtlpBoolValue = { boolValue: boolean };
type OtlpDoubleValue = { doubleValue: number };
type OtlpAttributeValue = OtlpStringValue | OtlpBoolValue | OtlpDoubleValue;

type OtlpAttribute = {
	key: string;
	value: OtlpAttributeValue;
};

type OtlpNumberDataPoint = {
	attributes?: OtlpAttribute[];
	asDouble: number;
	timeUnixNano: string;
};

type OtlpHistogramDataPoint = {
	attributes?: OtlpAttribute[];
	count: string;
	sum: number;
	bucketCounts: string[];
	explicitBounds: readonly number[];
	timeUnixNano: string;
};

type OtlpMetric =
	| {
			name: string;
			sum: {
				aggregationTemporality: typeof OTLP_AGGREGATION_TEMPORALITY_DELTA;
				isMonotonic: true;
				dataPoints: OtlpNumberDataPoint[];
			};
	  }
	| {
			name: string;
			gauge: {
				dataPoints: OtlpNumberDataPoint[];
			};
	  }
	| {
			name: string;
			histogram: {
				aggregationTemporality: typeof OTLP_AGGREGATION_TEMPORALITY_DELTA;
				dataPoints: OtlpHistogramDataPoint[];
			};
	  };

export type OtlpMetricsPayload = {
	resourceMetrics: Array<{
		resource: {
			attributes: OtlpAttribute[];
		};
		scopeMetrics: Array<{
			scope: {
				name: string;
			};
			metrics: OtlpMetric[];
		}>;
	}>;
};

export type GrafanaOtlpEnvLike = Partial<Record<string, unknown>>;

export type GrafanaOtlpSinkConfig = {
	endpoint: string;
	username?: string;
	apiToken?: string;
	authHeader?: string;
};

type GrafanaOtlpMetricsSinkOptions = GrafanaOtlpSinkConfig & {
	fetchFn?: typeof fetch;
};

type AggregatedMetricDataPoint = {
	attributes: OtlpAttribute[];
	bucketCounts: number[];
	count: number;
	timestampMs: number;
	value: number;
};

const OTLP_SCOPE_NAME = "thoughtspot.mcp.metrics.runtime";
const OTLP_AGGREGATION_TEMPORALITY_DELTA = 1;
const MAX_EXPORT_ERROR_BODY_LENGTH = 1_000;
const JSON_HEADERS = {
	"Content-Type": "application/json",
};

function getProcessEnvValue(name: string): string | undefined {
	if (typeof process === "undefined") {
		return undefined;
	}
	return process.env?.[name];
}

function readConfigValue(
	env: GrafanaOtlpEnvLike | undefined,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const envValue = env?.[key];
		if (typeof envValue === "string" && envValue.length > 0) {
			return envValue;
		}

		const processEnvValue = getProcessEnvValue(key);
		if (processEnvValue && processEnvValue.length > 0) {
			return processEnvValue;
		}
	}

	return undefined;
}

function decodeHeaderValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function readOtlpAuthorizationHeader(
	env: GrafanaOtlpEnvLike | undefined,
): string | undefined {
	const rawHeaders = readConfigValue(env, "OTEL_EXPORTER_OTLP_HEADERS");
	if (!rawHeaders) {
		return undefined;
	}

	for (const header of rawHeaders.split(",")) {
		const separatorIndex = header.indexOf("=");
		if (separatorIndex === -1) {
			continue;
		}

		const key = header.slice(0, separatorIndex).trim().toLowerCase();
		if (key !== "authorization") {
			continue;
		}

		const value = header.slice(separatorIndex + 1).trim();
		return value ? decodeHeaderValue(value) : undefined;
	}

	return undefined;
}

function encodeBase64(value: string): string {
	if (typeof Buffer !== "undefined") {
		return Buffer.from(value, "utf8").toString("base64");
	}
	if (typeof TextEncoder !== "undefined" && typeof btoa === "function") {
		const bytes = new TextEncoder().encode(value);
		let binary = "";
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		return btoa(binary);
	}
	throw new Error("No base64 encoder is available for Grafana OTLP auth");
}

function toOtlpValue(value: MetricLabelValue | string): OtlpAttributeValue {
	if (typeof value === "boolean") {
		return { boolValue: value };
	}
	if (typeof value === "number") {
		return { doubleValue: value };
	}
	return { stringValue: value };
}

function toAttributes(
	attributes: Record<string, MetricLabelValue | string | undefined>,
): OtlpAttribute[] {
	return Object.keys(attributes)
		.sort()
		.flatMap((key) => {
			const value = attributes[key];
			if (value === undefined || value === "") {
				return [];
			}
			return [{ key, value: toOtlpValue(value) }];
		});
}

function toTimeUnixNano(timestampMs: number): string {
	const integerMs = Math.trunc(timestampMs);
	const fractionalMs = timestampMs - integerMs;
	const fractionalMicros = Math.round(fractionalMs * 1_000);
	return (
		BigInt(integerMs) * 1_000_000n +
		BigInt(fractionalMicros) * 1_000n
	).toString();
}

function getHistogramBucketIndex(value: number): number {
	const bucketIndex = HISTOGRAM_BUCKETS_MS.findIndex((bound) => value <= bound);
	return bucketIndex === -1 ? HISTOGRAM_BUCKETS_MS.length : bucketIndex;
}

function groupObservationsByMetric(
	observations: readonly MetricObservation[],
): Map<MetricName, MetricObservation[]> {
	const grouped = new Map<MetricName, MetricObservation[]>();
	for (const observation of observations) {
		const metricObservations = grouped.get(observation.name) ?? [];
		metricObservations.push(observation);
		grouped.set(observation.name, metricObservations);
	}
	return grouped;
}

function getAttributeSetKey(attributes: readonly OtlpAttribute[]): string {
	return JSON.stringify(attributes);
}

function toNumberDataPoint(
	observation: AggregatedMetricDataPoint,
): OtlpNumberDataPoint {
	return {
		attributes: observation.attributes,
		asDouble: observation.value,
		timeUnixNano: toTimeUnixNano(observation.timestampMs),
	};
}

function toHistogramDataPoint(
	observation: AggregatedMetricDataPoint,
): OtlpHistogramDataPoint {
	return {
		attributes: observation.attributes,
		count: String(observation.count),
		sum: observation.value,
		bucketCounts: observation.bucketCounts.map(String),
		explicitBounds: HISTOGRAM_BUCKETS_MS,
		timeUnixNano: toTimeUnixNano(observation.timestampMs),
	};
}

function aggregateObservations(
	kind: MetricKind,
	observations: readonly MetricObservation[],
): AggregatedMetricDataPoint[] {
	const aggregated = new Map<string, AggregatedMetricDataPoint>();

	for (const observation of observations) {
		const attributes = toAttributes(observation.labels);
		const attributeSetKey = getAttributeSetKey(attributes);
		const dataPoint = aggregated.get(attributeSetKey) ?? {
			attributes,
			bucketCounts:
				kind === "histogram"
					? (new Array(HISTOGRAM_BUCKETS_MS.length + 1).fill(0) as number[])
					: [],
			count: 0,
			timestampMs: observation.timestampMs,
			value: 0,
		};

		switch (kind) {
			case "counter":
				dataPoint.value += observation.value;
				dataPoint.count += 1;
				dataPoint.timestampMs = observation.timestampMs;
				break;
			case "gauge":
				dataPoint.value = observation.value;
				dataPoint.count = 1;
				dataPoint.timestampMs = observation.timestampMs;
				break;
			case "histogram": {
				const bucketIndex = getHistogramBucketIndex(observation.value);
				dataPoint.bucketCounts[bucketIndex] += 1;
				dataPoint.value += observation.value;
				dataPoint.count += 1;
				dataPoint.timestampMs = observation.timestampMs;
				break;
			}
		}

		aggregated.set(attributeSetKey, dataPoint);
	}

	return [...aggregated.values()];
}

function toOtlpMetric(
	name: MetricName,
	kind: MetricKind,
	observations: readonly MetricObservation[],
): OtlpMetric {
	const dataPoints = aggregateObservations(kind, observations);

	switch (kind) {
		case "counter":
			return {
				name,
				sum: {
					aggregationTemporality: OTLP_AGGREGATION_TEMPORALITY_DELTA,
					isMonotonic: true,
					dataPoints: dataPoints.map(toNumberDataPoint),
				},
			};
		case "gauge":
			return {
				name,
				gauge: {
					dataPoints: dataPoints.map(toNumberDataPoint),
				},
			};
		case "histogram":
			return {
				name,
				histogram: {
					aggregationTemporality: OTLP_AGGREGATION_TEMPORALITY_DELTA,
					dataPoints: dataPoints.map(toHistogramDataPoint),
				},
			};
	}
}

function normalizeOtlpMetricsEndpoint(endpoint: string): string {
	const trimmed = endpoint.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/v1/metrics") ? trimmed : `${trimmed}/v1/metrics`;
}

function buildAuthorizationHeader(
	config: Pick<GrafanaOtlpSinkConfig, "apiToken" | "authHeader" | "username">,
): string | undefined {
	if (config.authHeader) {
		return config.authHeader;
	}
	if (config.username && config.apiToken) {
		return `Basic ${encodeBase64(`${config.username}:${config.apiToken}`)}`;
	}
	return undefined;
}

function buildRequestHeaders(config: GrafanaOtlpSinkConfig): HeadersInit {
	const authorization = buildAuthorizationHeader(config);
	return authorization
		? { ...JSON_HEADERS, Authorization: authorization }
		: JSON_HEADERS;
}

async function getExportErrorBody(response: Response): Promise<string> {
	const text = await response.text();
	if (text.length <= MAX_EXPORT_ERROR_BODY_LENGTH) {
		return text;
	}
	return `${text.slice(0, MAX_EXPORT_ERROR_BODY_LENGTH)}...`;
}

export function toOtlpMetricsPayload(
	payload: MetricsFlushPayload,
): OtlpMetricsPayload {
	const grouped = groupObservationsByMetric(payload.observations);

	return {
		resourceMetrics: [
			{
				resource: {
					attributes: toAttributes(payload.resourceAttributes),
				},
				scopeMetrics: [
					{
						scope: { name: OTLP_SCOPE_NAME },
						metrics: [...grouped.entries()].map(([name, observations]) =>
							toOtlpMetric(name, observations[0].kind, observations),
						),
					},
				],
			},
		],
	};
}

export function resolveGrafanaOtlpSinkConfig(
	env?: GrafanaOtlpEnvLike,
): GrafanaOtlpSinkConfig | undefined {
	const endpoint = readConfigValue(
		env,
		"GRAFANA_OTLP_METRICS_ENDPOINT",
		"GRAFANA_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
		"OTEL_EXPORTER_OTLP_ENDPOINT",
	);
	if (!endpoint) {
		return undefined;
	}

	return {
		endpoint: normalizeOtlpMetricsEndpoint(endpoint),
		username: readConfigValue(
			env,
			"GRAFANA_OTLP_USERNAME",
			"GRAFANA_CLOUD_ACCOUNT_ID",
			"GRAFANA_CLOUD_INSTANCE_ID",
		),
		apiToken: readConfigValue(
			env,
			"GRAFANA_OTLP_API_TOKEN",
			"GRAFANA_CLOUD_API_TOKEN",
		),
		authHeader:
			readConfigValue(
				env,
				"GRAFANA_OTLP_AUTH_HEADER",
				"OTEL_EXPORTER_OTLP_AUTH_HEADER",
			) ?? readOtlpAuthorizationHeader(env),
	};
}

export class GrafanaOtlpMetricsSink implements MetricsSink {
	private readonly endpoint: string;
	private readonly fetchFn: typeof fetch;
	private readonly headers: HeadersInit;

	constructor(options: GrafanaOtlpMetricsSinkOptions) {
		this.endpoint = normalizeOtlpMetricsEndpoint(options.endpoint);
		this.fetchFn = options.fetchFn ?? fetch;
		this.headers = buildRequestHeaders(options);
	}

	async flush(payload: MetricsFlushPayload): Promise<void> {
		if (payload.observations.length === 0) {
			return;
		}

		const response = await this.fetchFn(this.endpoint, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(toOtlpMetricsPayload(payload)),
		});

		if (!response.ok) {
			throw new Error(
				`Grafana OTLP metrics export failed with status ${response.status}: ${await getExportErrorBody(response)}`,
			);
		}
	}
}

export function createGrafanaOtlpMetricsSink(
	env?: GrafanaOtlpEnvLike,
): GrafanaOtlpMetricsSink | undefined {
	const config = resolveGrafanaOtlpSinkConfig(env);
	return config ? new GrafanaOtlpMetricsSink(config) : undefined;
}

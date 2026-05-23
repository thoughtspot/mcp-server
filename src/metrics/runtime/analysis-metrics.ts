import {
	METRIC_NAMES,
	type MetricLabelInput,
	type MetricOutcome,
} from "./metric-types";
import type { MetricsRecorder } from "./metrics-recorder";

export const STREAM_STORAGE_OPERATIONS = {
	initialize: "initialize",
	append: "append",
	messages: "messages",
	alarm: "alarm",
	unknown: "unknown",
} as const;

export type StreamStorageOperation =
	(typeof STREAM_STORAGE_OPERATIONS)[keyof typeof STREAM_STORAGE_OPERATIONS];

function recordCountAnalysisMetric(
	recorder: MetricsRecorder | undefined,
	metricName: string,
	outcome: MetricOutcome,
	extraLabels?: MetricLabelInput,
): void {
	if (!recorder) {
		return;
	}

	recorder.count(metricName, 1, {
		outcome,
		...extraLabels,
	});
}

function recordHistogramAnalysisMetric(
	recorder: MetricsRecorder | undefined,
	metricName: string,
	durationMs: number,
	outcome: MetricOutcome,
	extraLabels?: MetricLabelInput,
): void {
	if (!recorder) {
		return;
	}

	recorder.histogram(metricName, durationMs, {
		outcome,
		...extraLabels,
	});
}

export function recordAnalysisSessionCreatedMetric(
	recorder: MetricsRecorder | undefined,
	outcome: MetricOutcome,
): void {
	recordCountAnalysisMetric(
		recorder,
		METRIC_NAMES.analysisSessionsCreatedTotal,
		outcome,
	);
}

export function recordAnalysisMessageSentMetric(
	recorder: MetricsRecorder | undefined,
	outcome: MetricOutcome,
): void {
	recordCountAnalysisMetric(
		recorder,
		METRIC_NAMES.analysisMessagesSentTotal,
		outcome,
	);
}

export function recordAnalysisUpdatesPolledMetric(
	recorder: MetricsRecorder | undefined,
	outcome: MetricOutcome,
): void {
	recordCountAnalysisMetric(
		recorder,
		METRIC_NAMES.analysisUpdatesPolledTotal,
		outcome,
	);
}

export function recordAnalysisPollWaitMetric(
	recorder: MetricsRecorder | undefined,
	durationMs: number,
	outcome: MetricOutcome,
	isDone: boolean,
): void {
	recordHistogramAnalysisMetric(
		recorder,
		METRIC_NAMES.analysisPollWaitMs,
		durationMs,
		outcome,
		{
			is_done: isDone,
		},
	);
}

export function recordAnalysisFirstBufferedUpdateMetric(
	recorder: MetricsRecorder | undefined,
	durationMs: number,
	outcome: MetricOutcome,
): void {
	recordHistogramAnalysisMetric(
		recorder,
		METRIC_NAMES.analysisFirstBufferedUpdateMs,
		durationMs,
		outcome,
	);
}

export function recordAnalysisFirstPollDelayMetric(
	recorder: MetricsRecorder | undefined,
	durationMs: number,
	outcome: MetricOutcome,
): void {
	recordHistogramAnalysisMetric(
		recorder,
		METRIC_NAMES.analysisFirstPollDelayMs,
		durationMs,
		outcome,
	);
}

export function recordAnalysisFirstNonEmptyResponseMetric(
	recorder: MetricsRecorder | undefined,
	durationMs: number,
	outcome: MetricOutcome,
): void {
	recordHistogramAnalysisMetric(
		recorder,
		METRIC_NAMES.analysisFirstNonEmptyResponseMs,
		durationMs,
		outcome,
	);
}

export function recordAnalysisSessionNeverPolledMetric(
	recorder: MetricsRecorder | undefined,
	outcome: MetricOutcome = "client_error",
): void {
	recordCountAnalysisMetric(
		recorder,
		METRIC_NAMES.analysisSessionsNeverPolledTotal,
		outcome,
	);
}

export function recordStreamStorageErrorMetric(
	recorder: MetricsRecorder | undefined,
	operation: StreamStorageOperation,
): void {
	if (!recorder) {
		return;
	}

	recorder.count(METRIC_NAMES.streamStorageErrorsTotal, 1, {
		operation,
	});
}

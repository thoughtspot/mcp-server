export interface DataSource {
	name: string;
	id: string;
	description: string;
}

// Error from a ThoughtSpot HTTP call, carrying the numeric status so callers can
// branch on it (e.g. 401/403 = no access) instead of parsing message strings.
// The response body is kept off `message` so it can't leak into logs/responses.
export class ThoughtSpotApiError extends Error {
	constructor(
		readonly status: number,
		operation: string,
		readonly body?: string,
	) {
		super(`${operation} failed with status ${status}`);
		this.name = "ThoughtSpotApiError";
	}
}

export interface DataSourceSuggestion {
	confidence: number;
	header: {
		description: string;
		displayName: string;
		guid: string;
	};
	llmReasoning: string;
}

export interface DataSourceSuggestionResponse {
	dataSources: DataSourceSuggestion[];
}

export interface Org {
	id: number;
	name: string;
	description?: string;
}

export interface SessionInfo {
	mixpanelToken: string;
	userGUID: string;
	userName: string;
	clusterName: string;
	clusterId: string;
	releaseVersion: string;
	currentOrgId: string;
	privileges: any;
	enableSpotterDataSourceDiscovery?: boolean;
	// Whether Orgs are enabled on this cluster (configInfo.orgsConfiguration.enabled).
	// Gates the org tools (list_orgs/switch_org).
	orgsEnabled?: boolean;
}

export interface BaseMessage {
	is_thinking: boolean;
}

export interface TextMessage extends BaseMessage {
	type: "text" | "text_chunk";
	text: string;
}

export interface AnswerMessage extends BaseMessage {
	type: "answer";
	answer_id: string;
	answer_title: string;
	answer_data_source_id: string;
	answer_query: string;
	iframe_url: string;
}

export type Message = TextMessage | AnswerMessage;

export interface StreamingMessagesState {
	messages: Message[];
	isDone: boolean;
}

export interface Answer {
	title: string;
	session_identifier: string;
	generation_number: number;
}

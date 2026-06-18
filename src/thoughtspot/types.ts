export interface DataSource {
	name: string;
	id: string;
	description: string;
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
	// The access token surfaced by /prism/preauth/info (set server-side via
	// sessionInfo.setAccessToken). Present for IAMv2/Okta sessions; used to mint
	// org-scoped bearer tokens. May be undefined for sessions that don't expose one.
	accessToken?: string;
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

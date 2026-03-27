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
}

export interface TextMessage {
	type: "text" | "text_chunk";
	text: string;
}

export interface AnswerMessage {
	type: "answer";
	answer_title: string;
	answer_query: string;
	iframe_url: string;
}

export type Message = TextMessage | AnswerMessage;

export interface StreamingMessagesState {
	messages: Message[];
	isDone: boolean;
}

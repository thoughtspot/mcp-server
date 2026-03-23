export interface DataSource {
    name: string;
    id: string;
    description: string;
}

export interface DataSourceSuggestion {
    confidence?: number | null | undefined;
    details?: {
        description?: string | null | undefined;
        data_source_name?: string | null | undefined;
        data_source_identifier?: string | null | undefined;
    };
    reasoning?: string | null | undefined;
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

/** Data source context for agent conversation */
export interface DataSourceContext {
    guid: string;
}

/** Answer context for agent conversation */
export interface AnswerContext {
    session_identifier: string;
    generation_number: number;
}

/** Liveboard context for agent conversation */
export interface LiveboardContext {
    liveboard_identifier: string;
    visualization_identifier: string;
}

/** Metadata context for creating an agent conversation */
export interface AgentConversationMetadataContext {
    type: "answer" | "liveboard" | "data_source";
    data_source_context?: DataSourceContext;
    answer_context?: AnswerContext;
    liveboard_context?: LiveboardContext;
}

/** Conversation settings for agent conversation */
export interface AgentConversationSettings {
    enable_contextual_change_analysis?: boolean;
    enable_natural_language_answer_generation?: boolean;
    enable_reasoning?: boolean;
}

/** Request options for creating an agent conversation */
export interface CreateAgentConversationOptions {
    metadata_context: AgentConversationMetadataContext;
    conversation_settings?: AgentConversationSettings;
}

/** Response from createAgentConversation */
export interface AgentConversation {
    conversation_id: string;
}

/** Request options for sending an agent message */
export interface SendAgentMessageOptions {
    messages: string[];
}

export interface AgentMessage {
    type: 'text' | 'text-chunk' |'answer';
    text?: string | null | undefined;
    answerTitle?: string | null | undefined;
    answerQuery?: string | null | undefined;
    answerFrameUrl?: string | null | undefined;
}

/** Response from sendAgentMessage */
export interface SendAgentMessageResponse {
    messages?: AgentMessage[];
} 
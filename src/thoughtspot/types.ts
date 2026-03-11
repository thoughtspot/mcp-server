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
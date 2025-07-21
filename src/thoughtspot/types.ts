export interface DataSource {
    name: string;
    id: string;
    description: string;
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
} 
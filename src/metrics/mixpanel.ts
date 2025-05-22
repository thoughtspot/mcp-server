import { ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk";
import mixpanel, { type Mixpanel } from "mixpanel-browser";
import type { SessionInfo } from "../thoughtspot/thoughtspot-service";
import type { Tracker } from "./index";


export class MixpanelTracker implements Tracker {
    private mixpanel: Mixpanel;

    constructor(sessionInfo: SessionInfo, clientName: string) {
        this.mixpanel = mixpanel.init(sessionInfo.mixpanelToken, {
            disable_cookie: true,
            disable_persistence: true,
            autocapture: false,
        }, 'mcpServer');
        this.mixpanel.identify(sessionInfo.userGUID);
        this.mixpanel.register_once({
            clusterId: sessionInfo.clusterId,
            clusterName: sessionInfo.clusterName,
            releaseVersion: sessionInfo.releaseVersion,
            clientName: clientName,
        });
    }

    track(eventName: string, props: { [key: string]: any }) {
        this.mixpanel.track(eventName, props);
    }
}

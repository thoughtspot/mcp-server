import { MixpanelClient } from "./mixpanel-client";
import type { SessionInfo } from "../../thoughtspot/thoughtspot-service";
import type { Tracker } from "../index";


export class MixpanelTracker implements Tracker {
    private mixpanel: MixpanelClient;

    constructor(sessionInfo: SessionInfo, client: any = {}) {
        this.mixpanel = new MixpanelClient(sessionInfo.mixpanelToken);
        this.mixpanel.identify(sessionInfo.userGUID);
        this.mixpanel.register({
            clusterId: sessionInfo.clusterId,
            clusterName: sessionInfo.clusterName,
            releaseVersion: sessionInfo.releaseVersion,
            clientName: client.clientName,
            clientId: client.clientId,
            registrationDate: client.registrationDate,
        });
    }

    async track(eventName: string, props: { [key: string]: any }) {
        try {
            await this.mixpanel.track(eventName, props);
        } catch (error) {
            console.error("Error tracking event: ", error, " for eventName: ", eventName, " and props: ", props);
        }
        console.debug("Tracked event: ", eventName, " with props: ", props);
    }
}

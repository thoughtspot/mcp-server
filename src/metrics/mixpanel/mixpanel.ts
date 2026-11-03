import type { SessionInfo } from "../../services/types";
import type { Tracker } from "../index";
import { MixpanelClient } from "./mixpanel-client";

export class MixpanelTracker implements Tracker {
	private mixpanel: MixpanelClient;

	constructor(sessionInfo: SessionInfo, client: any = {}) {
		client = client || {};
		const { mixpanelConfig, selfClusterId, selfClusterName } =
			sessionInfo.configInfo;
		const mixpanelToken = mixpanelConfig.production
			? mixpanelConfig.prodSdkKey
			: mixpanelConfig.devSdkKey;
		this.mixpanel = new MixpanelClient(mixpanelToken);
		this.mixpanel.identify(sessionInfo.userGUID);
		this.mixpanel.register({
			clusterId: selfClusterId,
			clusterName: selfClusterName,
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
			console.error(
				"Error tracking event: ",
				error,
				" for eventName: ",
				eventName,
				" and props: ",
				props,
			);
		}
		console.debug("Tracked event: ", eventName, " with props: ", props);
	}
}

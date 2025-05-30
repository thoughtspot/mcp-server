const TRACK_ENDPOINT = "https://api.mixpanel.com/track";

export class MixpanelClient {
    private distinctId = "";
    private superProperties: { [key: string]: any } = {};

    constructor(private token: string) { }

    identify(distinctId: string) {
        this.distinctId = distinctId;
    }

    register(props: { [key: string]: any }) {
        this.superProperties = props;
    }

    async track(eventName: string, props: { [key: string]: any }) {
        const payload = {
            event: eventName,
            properties: {
                ...this.superProperties,
                ...props,
                token: this.token,
                distinct_id: this.distinctId,
                time: new Date().getTime(),
            },
        };

        const response = await fetch(TRACK_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "accept": "text/plain"
            },
            body: JSON.stringify([payload]),
        });

        if (!response.ok) {
            throw new Error(`Failed to track event: ${response.statusText}`);
        }

        return response.text();
    }
}
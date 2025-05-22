export enum TrackEvent {
    CallTool = "mcp-call-tool",
    Init = "mcp-init",
}


export interface Tracker {
    track(eventName: string, props: { [key: string]: any }): void;
}

export class Trackers extends Set<Tracker> {
    track(eventName: TrackEvent, props: { [key: string]: any } = {}) {
        for (const tracker of this) {
            tracker.track(eventName, props);
        }
    }
}
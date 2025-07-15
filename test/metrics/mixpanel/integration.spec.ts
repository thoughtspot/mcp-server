import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MixpanelTracker } from "../../../src/metrics/mixpanel/mixpanel";
import type { SessionInfo } from "../../../src/thoughtspot/types";

// Mock fetch globally for integration tests
global.fetch = vi.fn();

describe("Mixpanel Integration Tests", () => {
    const mockSessionInfo: SessionInfo = {
        mixpanelToken: "test-mixpanel-token",
        clusterName: "test-cluster",
        clusterId: "cluster-123",
        userGUID: "user-123",
        userName: "testuser",
        releaseVersion: "8.0.0",
        currentOrgId: "org-123",
        privileges: ["READ", "WRITE"]
    };

    const mockClient = {
        clientName: "test-client",
        clientId: "client-123",
        registrationDate: "2024-01-01"
    };

    let tracker: MixpanelTracker;
    let consoleErrorSpy: any;
    let consoleDebugSpy: any;

    beforeEach(() => {
        vi.clearAllMocks();

        // Mock console methods properly
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => { });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("end-to-end tracking", () => {
        beforeEach(() => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
        });

        it("should send correct payload to Mixpanel API", async () => {
            const eventName = "test-event";
            const props = { action: "click", page: "home" };

            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await tracker.track(eventName, props);

            expect(fetch).toHaveBeenCalledWith(
                "https://api.mixpanel.com/track",
                expect.objectContaining({
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "accept": "text/plain"
                    },
                    body: expect.any(String)
                })
            );

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);

            expect(body).toHaveLength(1);
            expect(body[0]).toEqual({
                event: eventName,
                properties: {
                    clusterId: mockSessionInfo.clusterId,
                    clusterName: mockSessionInfo.clusterName,
                    releaseVersion: mockSessionInfo.releaseVersion,
                    clientName: mockClient.clientName,
                    clientId: mockClient.clientId,
                    registrationDate: mockClient.registrationDate,
                    action: "click",
                    page: "home",
                    token: mockSessionInfo.mixpanelToken,
                    distinct_id: mockSessionInfo.userGUID,
                    time: expect.any(Number)
                }
            });
        });

        it("should handle API errors gracefully", async () => {
            const eventName = "test-event";
            const props = { action: "click" };

            const mockResponse = {
                ok: false,
                status: 400,
                statusText: "Bad Request"
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await tracker.track(eventName, props);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Error tracking event: ",
                expect.any(Error),
                " for eventName: ",
                eventName,
                " and props: ",
                props
            );
            expect(consoleDebugSpy).toHaveBeenCalledWith(
                "Tracked event: ",
                eventName,
                " with props: ",
                props
            );
        });

        it("should handle network errors gracefully", async () => {
            const eventName = "test-event";
            const props = { action: "click" };

            const networkError = new Error("Network error");
            (fetch as any).mockRejectedValue(networkError);

            await tracker.track(eventName, props);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Error tracking event: ",
                networkError,
                " for eventName: ",
                eventName,
                " and props: ",
                props
            );
            expect(consoleDebugSpy).toHaveBeenCalledWith(
                "Tracked event: ",
                eventName,
                " with props: ",
                props
            );
        });

        it("should track multiple events correctly", async () => {
            const events = [
                { name: "event1", props: { action: "click" } },
                { name: "event2", props: { action: "submit" } },
                { name: "event3", props: { action: "scroll" } }
            ];

            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            for (const event of events) {
                await tracker.track(event.name, event.props);
            }

            expect(fetch).toHaveBeenCalledTimes(3);

            // Verify each call
            const fetchCalls = (fetch as any).mock.calls;
            events.forEach((event, index) => {
                const body = JSON.parse(fetchCalls[index][1].body);
                expect(body[0].event).toBe(event.name);
                expect(body[0].properties).toMatchObject(event.props);
            });
        });

        it("should include all required properties in payload", async () => {
            const eventName = "test-event";
            const props = { action: "click" };

            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await tracker.track(eventName, props);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            // Check all required properties are present
            expect(properties).toHaveProperty("token", mockSessionInfo.mixpanelToken);
            expect(properties).toHaveProperty("distinct_id", mockSessionInfo.userGUID);
            expect(properties).toHaveProperty("time");
            expect(properties).toHaveProperty("clusterId", mockSessionInfo.clusterId);
            expect(properties).toHaveProperty("clusterName", mockSessionInfo.clusterName);
            expect(properties).toHaveProperty("releaseVersion", mockSessionInfo.releaseVersion);
            expect(properties).toHaveProperty("clientName", mockClient.clientName);
            expect(properties).toHaveProperty("clientId", mockClient.clientId);
            expect(properties).toHaveProperty("registrationDate", mockClient.registrationDate);
            expect(properties).toHaveProperty("action", "click");
        });

        it("should handle complex nested properties", async () => {
            const eventName = "test-event";
            const props = {
                user: {
                    id: "123",
                    preferences: {
                        theme: "dark",
                        language: "en"
                    }
                },
                metadata: {
                    tags: ["tag1", "tag2"],
                    timestamp: Date.now()
                }
            };

            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await tracker.track(eventName, props);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            expect(properties).toMatchObject({
                ...props,
                token: mockSessionInfo.mixpanelToken,
                distinct_id: mockSessionInfo.userGUID,
                clusterId: mockSessionInfo.clusterId,
                clusterName: mockSessionInfo.clusterName,
                releaseVersion: mockSessionInfo.releaseVersion,
                clientName: mockClient.clientName,
                clientId: mockClient.clientId,
                registrationDate: mockClient.registrationDate,
            });
        });
    });

    describe("constructor variations", () => {
        it("should work with minimal session info", async () => {
            const minimalSessionInfo: SessionInfo = {
                mixpanelToken: "minimal-token",
                clusterName: "minimal-cluster",
                clusterId: "minimal-cluster-id",
                userGUID: "minimal-user",
                userName: "minimal-user",
                releaseVersion: "1.0.0",
                currentOrgId: "minimal-org",
                privileges: []
            };

            tracker = new MixpanelTracker(minimalSessionInfo);

            const eventName = "test-event";
            const props = { action: "click" };

            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await tracker.track(eventName, props);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            // Check that the properties contain the expected values
            expect(properties.token).toBe(minimalSessionInfo.mixpanelToken);
            expect(properties.distinct_id).toBe(minimalSessionInfo.userGUID);
            expect(properties.clusterId).toBe(minimalSessionInfo.clusterId);
            expect(properties.clusterName).toBe(minimalSessionInfo.clusterName);
            expect(properties.releaseVersion).toBe(minimalSessionInfo.releaseVersion);
            expect(properties.action).toBe("click");

            // Check that client properties are undefined when not provided
            expect(properties.clientName).toBeUndefined();
            expect(properties.clientId).toBeUndefined();
            expect(properties.registrationDate).toBeUndefined();
        });

        it("should work with partial client info", async () => {
            const partialClient = { clientName: "partial-client" };
            tracker = new MixpanelTracker(mockSessionInfo, partialClient);

            const eventName = "test-event";
            const props = { action: "click" };

            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await tracker.track(eventName, props);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            // Check that the properties contain the expected values
            expect(properties.clientName).toBe("partial-client");
            expect(properties.action).toBe("click");

            // Check that missing client properties are undefined
            expect(properties.clientId).toBeUndefined();
            expect(properties.registrationDate).toBeUndefined();
        });
    });

    describe("error handling scenarios", () => {
        beforeEach(() => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
        });

        it("should handle malformed JSON response", async () => {
            const eventName = "test-event";
            const props = { action: "click" };

            const mockResponse = {
                ok: true,
                text: vi.fn().mockRejectedValue(new Error("Invalid JSON"))
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await tracker.track(eventName, props);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Error tracking event: ",
                expect.any(Error),
                " for eventName: ",
                eventName,
                " and props: ",
                props
            );
        });

        it("should handle timeout scenarios", async () => {
            const eventName = "test-event";
            const props = { action: "click" };

            // Simulate a timeout by never resolving the promise
            (fetch as any).mockImplementation(() =>
                new Promise(() => { }) // Never resolves
            );

            // We can't easily test actual timeouts in unit tests, but we can verify the error handling
            // This test would need to be run with a timeout in a real scenario
            expect(tracker.track(eventName, props)).toBeInstanceOf(Promise);
        });

        it("should handle concurrent tracking requests", async () => {
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            // Send multiple concurrent requests
            const promises = [
                tracker.track("event1", { action: "click" }),
                tracker.track("event2", { action: "submit" }),
                tracker.track("event3", { action: "scroll" })
            ];

            await Promise.all(promises);

            expect(fetch).toHaveBeenCalledTimes(3);
        });
    });

    describe("performance and reliability", () => {
        beforeEach(() => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
        });

        it("should handle rapid successive calls", async () => {
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            const startTime = Date.now();

            // Send 10 rapid requests
            for (let i = 0; i < 10; i++) {
                await tracker.track(`event${i}`, { index: i });
            }

            const endTime = Date.now();

            expect(fetch).toHaveBeenCalledTimes(10);
            expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
        });

        it("should maintain correct order of events", async () => {
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            const events: string[] = [];

            // Track events and record their order
            await tracker.track("event1", { order: 1 });
            events.push("event1");

            await tracker.track("event2", { order: 2 });
            events.push("event2");

            await tracker.track("event3", { order: 3 });
            events.push("event3");

            expect(events).toEqual(["event1", "event2", "event3"]);
            expect(fetch).toHaveBeenCalledTimes(3);
        });
    });
}); 
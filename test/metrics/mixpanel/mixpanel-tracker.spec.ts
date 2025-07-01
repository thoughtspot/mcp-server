import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MixpanelTracker } from "../../../src/metrics/mixpanel/mixpanel";
import { MixpanelClient } from "../../../src/metrics/mixpanel/mixpanel-client";
import type { SessionInfo } from "../../../src/thoughtspot/thoughtspot-service";

// Mock the MixpanelClient
vi.mock("../../../src/metrics/mixpanel/mixpanel-client");

describe("MixpanelTracker", () => {
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
    let mockMixpanelClient: any;
    let consoleErrorSpy: any;
    let consoleDebugSpy: any;

    beforeEach(() => {
        // Clear all mocks
        vi.clearAllMocks();
        
        // Create mock MixpanelClient instance
        mockMixpanelClient = {
            identify: vi.fn(),
            register: vi.fn(),
            track: vi.fn().mockResolvedValue("1")
        };

        // Mock the MixpanelClient constructor
        (MixpanelClient as any).mockImplementation(() => mockMixpanelClient);

        // Mock console methods properly
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("constructor", () => {
        it("should create MixpanelTracker instance", () => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
            
            expect(tracker).toBeInstanceOf(MixpanelTracker);
            expect(MixpanelClient).toHaveBeenCalledWith(mockSessionInfo.mixpanelToken);
        });

        it("should initialize MixpanelClient with correct token", () => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
            
            expect(MixpanelClient).toHaveBeenCalledWith(mockSessionInfo.mixpanelToken);
        });

        it("should call identify with userGUID", () => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
            
            expect(mockMixpanelClient.identify).toHaveBeenCalledWith(mockSessionInfo.userGUID);
        });

        it("should register super properties with session and client info", () => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
            
            expect(mockMixpanelClient.register).toHaveBeenCalledWith({
                clusterId: mockSessionInfo.clusterId,
                clusterName: mockSessionInfo.clusterName,
                releaseVersion: mockSessionInfo.releaseVersion,
                clientName: mockClient.clientName,
                clientId: mockClient.clientId,
                registrationDate: mockClient.registrationDate,
            });
        });

        it("should work with empty client object", () => {
            tracker = new MixpanelTracker(mockSessionInfo, {});
            
            expect(mockMixpanelClient.register).toHaveBeenCalledWith({
                clusterId: mockSessionInfo.clusterId,
                clusterName: mockSessionInfo.clusterName,
                releaseVersion: mockSessionInfo.releaseVersion,
                clientName: undefined,
                clientId: undefined,
                registrationDate: undefined,
            });
        });

        it("should work without client parameter", () => {
            tracker = new MixpanelTracker(mockSessionInfo);
            
            expect(mockMixpanelClient.register).toHaveBeenCalledWith({
                clusterId: mockSessionInfo.clusterId,
                clusterName: mockSessionInfo.clusterName,
                releaseVersion: mockSessionInfo.releaseVersion,
                clientName: undefined,
                clientId: undefined,
                registrationDate: undefined,
            });
        });

        it("should handle partial client object", () => {
            const partialClient = { clientName: "partial-client" };
            tracker = new MixpanelTracker(mockSessionInfo, partialClient);
            
            expect(mockMixpanelClient.register).toHaveBeenCalledWith({
                clusterId: mockSessionInfo.clusterId,
                clusterName: mockSessionInfo.clusterName,
                releaseVersion: mockSessionInfo.releaseVersion,
                clientName: "partial-client",
                clientId: undefined,
                registrationDate: undefined,
            });
        });

        it("should handle null client object", () => {
            tracker = new MixpanelTracker(mockSessionInfo, null as any);
            
            expect(mockMixpanelClient.register).toHaveBeenCalledWith({
                clusterId: mockSessionInfo.clusterId,
                clusterName: mockSessionInfo.clusterName,
                releaseVersion: mockSessionInfo.releaseVersion,
                clientName: undefined,
                clientId: undefined,
                registrationDate: undefined,
            });
        });
    });

    describe("track", () => {
        beforeEach(() => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
        });

        it("should track event successfully", async () => {
            const eventName = "test-event";
            const props = { action: "click", page: "home" };

            await tracker.track(eventName, props);

            expect(mockMixpanelClient.track).toHaveBeenCalledWith(eventName, props);
            expect(consoleDebugSpy).toHaveBeenCalledWith(
                "Tracked event: ",
                eventName,
                " with props: ",
                props
            );
        });

        it("should handle empty properties", async () => {
            const eventName = "test-event";
            const props = {};

            await tracker.track(eventName, props);

            expect(mockMixpanelClient.track).toHaveBeenCalledWith(eventName, props);
            expect(consoleDebugSpy).toHaveBeenCalledWith(
                "Tracked event: ",
                eventName,
                " with props: ",
                props
            );
        });

        it("should handle complex properties", async () => {
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

            await tracker.track(eventName, props);

            expect(mockMixpanelClient.track).toHaveBeenCalledWith(eventName, props);
        });

        it("should handle special characters in event name", async () => {
            const eventName = "test-event-with-special-chars!@#$%^&*()";
            const props = { action: "click" };

            await tracker.track(eventName, props);

            expect(mockMixpanelClient.track).toHaveBeenCalledWith(eventName, props);
        });

        it("should handle tracking errors gracefully", async () => {
            const eventName = "test-event";
            const props = { action: "click" };
            const error = new Error("Network error");

            mockMixpanelClient.track.mockRejectedValue(error);

            await tracker.track(eventName, props);

            expect(mockMixpanelClient.track).toHaveBeenCalledWith(eventName, props);
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Error tracking event: ",
                error,
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

        it("should handle different types of errors", async () => {
            const eventName = "test-event";
            const props = { action: "click" };
            const error = "String error";

            mockMixpanelClient.track.mockRejectedValue(error);

            await tracker.track(eventName, props);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Error tracking event: ",
                error,
                " for eventName: ",
                eventName,
                " and props: ",
                props
            );
        });

        it("should handle null error", async () => {
            const eventName = "test-event";
            const props = { action: "click" };

            mockMixpanelClient.track.mockRejectedValue(null);

            await tracker.track(eventName, props);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Error tracking event: ",
                null,
                " for eventName: ",
                eventName,
                " and props: ",
                props
            );
        });

        it("should handle undefined error", async () => {
            const eventName = "test-event";
            const props = { action: "click" };

            mockMixpanelClient.track.mockRejectedValue(undefined);

            await tracker.track(eventName, props);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Error tracking event: ",
                undefined,
                " for eventName: ",
                eventName,
                " and props: ",
                props
            );
        });

        it("should always log debug message even when error occurs", async () => {
            const eventName = "test-event";
            const props = { action: "click" };
            const error = new Error("Network error");

            mockMixpanelClient.track.mockRejectedValue(error);

            await tracker.track(eventName, props);

            expect(consoleDebugSpy).toHaveBeenCalledWith(
                "Tracked event: ",
                eventName,
                " with props: ",
                props
            );
        });

        it("should handle multiple consecutive track calls", async () => {
            const events = [
                { name: "event1", props: { action: "click" } },
                { name: "event2", props: { action: "submit" } },
                { name: "event3", props: { action: "scroll" } }
            ];

            for (const event of events) {
                await tracker.track(event.name, event.props);
            }

            expect(mockMixpanelClient.track).toHaveBeenCalledTimes(3);
            expect(mockMixpanelClient.track).toHaveBeenNthCalledWith(1, "event1", { action: "click" });
            expect(mockMixpanelClient.track).toHaveBeenNthCalledWith(2, "event2", { action: "submit" });
            expect(mockMixpanelClient.track).toHaveBeenNthCalledWith(3, "event3", { action: "scroll" });
        });

        it("should handle async operations correctly", async () => {
            const eventName = "test-event";
            const props = { action: "click" };

            // Simulate async delay
            mockMixpanelClient.track.mockImplementation(() => 
                new Promise(resolve => setTimeout(() => resolve("1"), 10))
            );

            const startTime = Date.now();
            await tracker.track(eventName, props);
            const endTime = Date.now();

            expect(endTime - startTime).toBeGreaterThanOrEqual(5); // Should have some delay
            expect(mockMixpanelClient.track).toHaveBeenCalledWith(eventName, props);
        });
    });

    describe("integration with Tracker interface", () => {
        it("should implement Tracker interface correctly", () => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
            
            // Check that the track method exists and is callable
            expect(typeof tracker.track).toBe("function");
            expect(tracker.track).toBeInstanceOf(Function);
        });

        it("should handle TrackEvent enum values", async () => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
            
            // Import TrackEvent enum
            const { TrackEvent } = await import("../../../src/metrics");
            
            await tracker.track(TrackEvent.CallTool, { toolName: "test-tool" });
            await tracker.track(TrackEvent.Init, { version: "1.0.0" });

            expect(mockMixpanelClient.track).toHaveBeenCalledTimes(2);
            expect(mockMixpanelClient.track).toHaveBeenNthCalledWith(1, TrackEvent.CallTool, { toolName: "test-tool" });
            expect(mockMixpanelClient.track).toHaveBeenNthCalledWith(2, TrackEvent.Init, { version: "1.0.0" });
        });
    });

    describe("error scenarios", () => {
        beforeEach(() => {
            tracker = new MixpanelTracker(mockSessionInfo, mockClient);
        });

        it("should handle MixpanelClient constructor errors", () => {
            const constructorError = new Error("Failed to create client");
            (MixpanelClient as any).mockImplementation(() => {
                throw constructorError;
            });

            expect(() => new MixpanelTracker(mockSessionInfo, mockClient)).toThrow("Failed to create client");
        });

        it("should handle identify method errors", () => {
            mockMixpanelClient.identify.mockImplementation(() => {
                throw new Error("Identify failed");
            });

            expect(() => new MixpanelTracker(mockSessionInfo, mockClient)).toThrow("Identify failed");
        });

        it("should handle register method errors", () => {
            mockMixpanelClient.register.mockImplementation(() => {
                throw new Error("Register failed");
            });

            expect(() => new MixpanelTracker(mockSessionInfo, mockClient)).toThrow("Register failed");
        });

        it("should handle track method throwing synchronous errors", async () => {
            const syncError = new Error("Sync error");
            mockMixpanelClient.track.mockImplementation(() => {
                throw syncError;
            });

            await tracker.track("test-event", { action: "click" });

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Error tracking event: ",
                syncError,
                " for eventName: ",
                "test-event",
                " and props: ",
                { action: "click" }
            );
        });
    });
}); 
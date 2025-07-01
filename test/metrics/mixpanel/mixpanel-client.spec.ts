import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MixpanelClient } from "../../../src/metrics/mixpanel/mixpanel-client";

// Mock fetch globally
global.fetch = vi.fn();

describe("MixpanelClient", () => {
    const mockToken = "test-mixpanel-token";
    let client: MixpanelClient;

    beforeEach(() => {
        client = new MixpanelClient(mockToken);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    describe("constructor", () => {
        it("should initialize with token", () => {
            expect(client).toBeInstanceOf(MixpanelClient);
        });

        it("should store token internally", () => {
            const testToken = "test-token-123";
            const testClient = new MixpanelClient(testToken);
            // We can't directly access private properties, but we can test behavior
            expect(testClient).toBeDefined();
        });
    });

    describe("identify", () => {
        it("should set distinct ID", () => {
            const distinctId = "user-123";
            client.identify(distinctId);
            
            // Test that identify doesn't throw and can be called
            expect(() => client.identify(distinctId)).not.toThrow();
        });

        it("should accept empty string", () => {
            expect(() => client.identify("")).not.toThrow();
        });

        it("should accept special characters", () => {
            const specialId = "user@example.com#123";
            expect(() => client.identify(specialId)).not.toThrow();
        });
    });

    describe("register", () => {
        it("should register super properties", () => {
            const props = {
                clusterId: "cluster-123",
                clusterName: "test-cluster",
                releaseVersion: "8.0.0"
            };
            
            expect(() => client.register(props)).not.toThrow();
        });

        it("should accept empty object", () => {
            expect(() => client.register({})).not.toThrow();
        });

        it("should accept nested objects", () => {
            const nestedProps = {
                user: {
                    id: "123",
                    name: "test"
                },
                metadata: {
                    version: "1.0.0"
                }
            };
            
            expect(() => client.register(nestedProps)).not.toThrow();
        });

        it("should accept arrays", () => {
            const propsWithArray = {
                tags: ["tag1", "tag2"],
                numbers: [1, 2, 3]
            };
            
            expect(() => client.register(propsWithArray)).not.toThrow();
        });
    });

    describe("track", () => {
        const mockDistinctId = "user-123";
        const mockSuperProps = {
            clusterId: "cluster-123",
            clusterName: "test-cluster"
        };

        beforeEach(() => {
            client.identify(mockDistinctId);
            client.register(mockSuperProps);
        });

        it("should track event successfully", async () => {
            const eventName = "test-event";
            const eventProps = { action: "click", page: "home" };
            
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            const result = await client.track(eventName, eventProps);

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
                properties: expect.objectContaining({
                    ...mockSuperProps,
                    ...eventProps,
                    token: mockToken,
                    distinct_id: mockDistinctId,
                    time: expect.any(Number)
                })
            });

            expect(result).toBe("1");
        });

        it("should include timestamp in payload", async () => {
            const eventName = "test-event";
            const eventProps = { action: "click" };
            
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            const beforeTime = Date.now();
            await client.track(eventName, eventProps);
            const afterTime = Date.now();

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const payloadTime = body[0].properties.time;

            expect(payloadTime).toBeGreaterThanOrEqual(beforeTime);
            expect(payloadTime).toBeLessThanOrEqual(afterTime);
        });

        it("should merge super properties with event properties", async () => {
            const eventName = "test-event";
            const eventProps = { action: "click" };
            
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await client.track(eventName, eventProps);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            expect(properties).toMatchObject({
                ...mockSuperProps,
                ...eventProps,
                token: mockToken,
                distinct_id: mockDistinctId
            });
        });

        it("should handle event properties overriding super properties", async () => {
            const eventName = "test-event";
            const eventProps = { 
                clusterId: "overridden-cluster", // This should override the super property
                action: "click" 
            };
            
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await client.track(eventName, eventProps);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            expect(properties.clusterId).toBe("overridden-cluster");
            expect(properties.clusterName).toBe("test-cluster"); // Should remain from super properties
            expect(properties.action).toBe("click");
        });

        it("should handle empty event properties", async () => {
            const eventName = "test-event";
            
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await client.track(eventName, {});

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            expect(properties).toMatchObject({
                ...mockSuperProps,
                token: mockToken,
                distinct_id: mockDistinctId
            });
        });

        it("should handle HTTP error responses", async () => {
            const eventName = "test-event";
            const eventProps = { action: "click" };
            
            const mockResponse = {
                ok: false,
                status: 400,
                statusText: "Bad Request"
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await expect(client.track(eventName, eventProps)).rejects.toThrow(
                "Failed to track event: Bad Request"
            );
        });

        it("should handle network errors", async () => {
            const eventName = "test-event";
            const eventProps = { action: "click" };
            
            const networkError = new Error("Network error");
            (fetch as any).mockRejectedValue(networkError);

            await expect(client.track(eventName, eventProps)).rejects.toThrow("Network error");
        });

        it("should handle JSON parsing errors in response", async () => {
            const eventName = "test-event";
            const eventProps = { action: "click" };
            
            const mockResponse = {
                ok: true,
                text: vi.fn().mockRejectedValue(new Error("Invalid JSON"))
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await expect(client.track(eventName, eventProps)).rejects.toThrow("Invalid JSON");
        });

        it("should work without calling identify first", async () => {
            const newClient = new MixpanelClient(mockToken);
            newClient.register(mockSuperProps);
            
            const eventName = "test-event";
            const eventProps = { action: "click" };
            
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await newClient.track(eventName, eventProps);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            expect(properties.distinct_id).toBe(""); // Should be empty string
            expect(properties).toMatchObject({
                ...mockSuperProps,
                ...eventProps,
                token: mockToken
            });
        });

        it("should work without calling register first", async () => {
            const newClient = new MixpanelClient(mockToken);
            newClient.identify(mockDistinctId);
            
            const eventName = "test-event";
            const eventProps = { action: "click" };
            
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await newClient.track(eventName, eventProps);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            expect(properties).toMatchObject({
                ...eventProps,
                token: mockToken,
                distinct_id: mockDistinctId
            });
        });

        it("should handle special characters in event name", async () => {
            const eventName = "test-event-with-special-chars!@#$%^&*()";
            const eventProps = { action: "click" };
            
            const mockResponse = {
                ok: true,
                text: vi.fn().mockResolvedValue("1")
            };
            (fetch as any).mockResolvedValue(mockResponse);

            await client.track(eventName, eventProps);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            
            expect(body[0].event).toBe(eventName);
        });

        it("should handle complex nested properties", async () => {
            const eventName = "test-event";
            const eventProps = {
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

            await client.track(eventName, eventProps);

            const fetchCall = (fetch as any).mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const properties = body[0].properties;

            expect(properties).toMatchObject({
                ...mockSuperProps,
                ...eventProps,
                token: mockToken,
                distinct_id: mockDistinctId
            });
        });
    });
}); 
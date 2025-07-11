import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trace, context } from "@opentelemetry/api";
import { getActiveSpan, withSpan, WithSpan, withSpanNamed } from "../../../src/metrics/tracing/tracing-utils";

describe("tracing-utils", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    describe("getActiveSpan", () => {
        it("should return provided span override when given", () => {
            const mockSpan = { 
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            const result = getActiveSpan(mockSpan as any);
            
            expect(result).toBe(mockSpan);
        });

        it("should return active span from context when no override provided", () => {
            const mockActiveSpan = { 
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockContext = {} as any;
            vi.mocked(context.active).mockReturnValue(mockContext);
            vi.mocked(trace.getSpan).mockReturnValue(mockActiveSpan as any);
            
            const result = getActiveSpan();
            
            expect(trace.getSpan).toHaveBeenCalledWith(mockContext);
            expect(result).toBe(mockActiveSpan);
        });

        it("should return undefined when no active span and no override", () => {
            const mockContext = {} as any;
            vi.mocked(context.active).mockReturnValue(mockContext);
            vi.mocked(trace.getSpan).mockReturnValue(undefined);
            
            const result = getActiveSpan();
            
            expect(result).toBeUndefined();
        });
    });

    describe("withSpan", () => {
        it("should create a span with given name and execute function", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            const testFn = vi.fn().mockResolvedValue("test-result");
            const result = await withSpan("test-operation", testFn);
            
            expect(trace.getTracer).toHaveBeenCalledWith("thoughtspot-mcp-server");
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("test-operation", expect.any(Function));
            expect(testFn).toHaveBeenCalledWith(mockSpan);
            expect(result).toBe("test-result");
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it("should record exception and end span when function throws", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            const testError = new Error("Test error");
            const testFn = vi.fn().mockRejectedValue(testError);
            
            await expect(withSpan("test-operation", testFn)).rejects.toThrow("Test error");
            
            expect(mockSpan.recordException).toHaveBeenCalledWith(testError);
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it("should ignore parentSpan parameter for backward compatibility", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            const testFn = vi.fn().mockResolvedValue("test-result");
            const parentSpan = { setAttribute: vi.fn() };
            
            await withSpan("test-operation", testFn, parentSpan as any);
            
            // Should still use startActiveSpan regardless of parentSpan
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("test-operation", expect.any(Function));
        });
    });

    describe("WithSpan decorator", () => {
        it("should wrap method with span tracing", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            class TestClass {
                @WithSpan("test-method")
                async testMethod(arg: string): Promise<string> {
                    return `processed-${arg}`;
                }
            }
            
            const instance = new TestClass();
            const result = await instance.testMethod("test");
            
            expect(trace.getTracer).toHaveBeenCalledWith("thoughtspot-mcp-server");
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("test-method", expect.any(Function));
            expect(result).toBe("processed-test");
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it("should record exception when decorated method throws", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            class TestClass {
                @WithSpan("failing-method")
                async failingMethod(): Promise<void> {
                    throw new Error("Method failed");
                }
            }
            
            const instance = new TestClass();
            
            await expect(instance.failingMethod()).rejects.toThrow("Method failed");
            
            expect(mockSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it("should preserve method context (this)", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            class TestClass {
                value = "test-value";
                
                @WithSpan("context-method")
                async contextMethod(): Promise<string> {
                    return this.value;
                }
            }
            
            const instance = new TestClass();
            const result = await instance.contextMethod();
            
            expect(result).toBe("test-value");
        });

        it("should throw error when applied to non-method", () => {
            expect(() => {
                // Create a descriptor that's not a method
                const descriptor: TypedPropertyDescriptor<any> = {
                    value: undefined
                };
                
                WithSpan("test-property")({}, "property", descriptor);
            }).toThrow("WithSpan can only be applied to methods");
        });

        it("should work with methods that have multiple parameters", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            class TestClass {
                @WithSpan("multi-param-method")
                async multiParamMethod(a: string, b: number, c: boolean): Promise<string> {
                    return `${a}-${b}-${c}`;
                }
            }
            
            const instance = new TestClass();
            const result = await instance.multiParamMethod("test", 42, true);
            
            expect(result).toBe("test-42-true");
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("multi-param-method", expect.any(Function));
        });
    });

    describe("withSpanNamed", () => {
        it("should return a function that creates spans with given name", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            const namedSpanFn = withSpanNamed("named-operation");
            const testFn = vi.fn().mockResolvedValue("named-result");
            
            const result = await namedSpanFn(testFn);
            
            expect(trace.getTracer).toHaveBeenCalledWith("thoughtspot-mcp-server");
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("named-operation", expect.any(Function));
            expect(testFn).toHaveBeenCalledWith(mockSpan);
            expect(result).toBe("named-result");
        });

        it("should handle exceptions in named span function", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            const namedSpanFn = withSpanNamed("failing-named-operation");
            const testError = new Error("Named function failed");
            const testFn = vi.fn().mockRejectedValue(testError);
            
            await expect(namedSpanFn(testFn)).rejects.toThrow("Named function failed");
            
            expect(mockSpan.recordException).toHaveBeenCalledWith(testError);
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it("should ignore parentSpan parameter for backward compatibility", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            const namedSpanFn = withSpanNamed("named-operation");
            const testFn = vi.fn().mockResolvedValue("result");
            const parentSpan = { setAttribute: vi.fn() };
            
            await namedSpanFn(testFn, parentSpan as any);
            
            // Should still use startActiveSpan regardless of parentSpan
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("named-operation", expect.any(Function));
        });

        it("should create different named functions for different names", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            const namedSpanFn1 = withSpanNamed("operation-1");
            const namedSpanFn2 = withSpanNamed("operation-2");
            
            const testFn1 = vi.fn().mockResolvedValue("result-1");
            const testFn2 = vi.fn().mockResolvedValue("result-2");
            
            await namedSpanFn1(testFn1);
            await namedSpanFn2(testFn2);
            
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("operation-1", expect.any(Function));
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("operation-2", expect.any(Function));
        });
    });

    describe("integration tests", () => {
        it("should work with real span attributes", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            const result = await withSpan("test-with-attributes", async (span) => {
                span.setAttribute("key1", "value1");
                span.setAttribute("key2", 42);
                return "success";
            });
            
            expect(mockSpan.setAttribute).toHaveBeenCalledWith("key1", "value1");
            expect(mockSpan.setAttribute).toHaveBeenCalledWith("key2", 42);
            expect(result).toBe("success");
        });

        it("should work with decorator and span attributes", async () => {
            const mockSpan = {
                setAttribute: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn()
            };
            
            const mockTracer = {
                startActiveSpan: vi.fn((name, fn) => fn(mockSpan))
            };
            
            vi.mocked(trace.getTracer).mockReturnValue(mockTracer as any);
            
            class TestService {
                @WithSpan("service-method")
                async serviceMethod(userId: string): Promise<string> {
                    // In real usage, we'd access the span through context
                    // but for testing, we'll just return the userId
                    return `user-${userId}`;
                }
            }
            
            const service = new TestService();
            const result = await service.serviceMethod("123");
            
            expect(result).toBe("user-123");
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("service-method", expect.any(Function));
        });
    });
}); 
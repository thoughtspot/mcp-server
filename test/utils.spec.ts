import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { McpServerError, type Props } from "../src/utils";
import { getActiveSpan } from "../src/metrics/tracing/tracing-utils";

// Mock the tracing utils
vi.mock("../src/metrics/tracing/tracing-utils", () => ({
    getActiveSpan: vi.fn()
}));

describe("utils", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Clear console.error mock
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    describe("Props type", () => {
        it("should have correct type structure", () => {
            const props: Props = {
                accessToken: "test-token",
                instanceUrl: "https://test.thoughtspot.com",
                clientName: {
                    clientId: "test-client-id",
                    clientName: "Test Client",
                    registrationDate: 1234567890
                }
            };

            expect(props.accessToken).toBe("test-token");
            expect(props.instanceUrl).toBe("https://test.thoughtspot.com");
            expect(props.clientName.clientId).toBe("test-client-id");
            expect(props.clientName.clientName).toBe("Test Client");
            expect(props.clientName.registrationDate).toBe(1234567890);
        });
    });

    describe("McpServerError", () => {
        describe("constructor", () => {
            it("should create error with string message", () => {
                const error = new McpServerError("Test error message", 400);

                expect(error.message).toBe("Test error message");
                expect(error.statusCode).toBe(400);
                expect(error.errorJson).toBe("Test error message");
                expect(error.name).toBe("McpServerError");
                expect(error).toBeInstanceOf(Error);
                expect(error).toBeInstanceOf(McpServerError);
            });

            it("should create error with object containing message property", () => {
                const errorObj = { message: "Object error message", code: "ERR_001" };
                const error = new McpServerError(errorObj, 500);

                expect(error.message).toBe("Object error message");
                expect(error.statusCode).toBe(500);
                expect(error.errorJson).toEqual(errorObj);
            });

            it("should create error with object containing error property", () => {
                const errorObj = { error: "Error property message", details: "Some details" };
                const error = new McpServerError(errorObj, 422);

                expect(error.message).toBe("Error property message");
                expect(error.statusCode).toBe(422);
                expect(error.errorJson).toEqual(errorObj);
            });

            it("should create error with fallback message for object without message/error", () => {
                const errorObj = { code: "ERR_002", details: "Some details" };
                const error = new McpServerError(errorObj, 400);

                expect(error.message).toBe("Unknown error occurred");
                expect(error.statusCode).toBe(400);
                expect(error.errorJson).toEqual(errorObj);
            });

            it("should create error with fallback message for null/undefined input", () => {
                const error1 = new McpServerError(null, 400);
                const error2 = new McpServerError(undefined, 400);

                expect(error1.message).toBe("Unknown error occurred");
                expect(error2.message).toBe("Unknown error occurred");
            });

            it("should log error to console", () => {
                const consoleSpy = vi.spyOn(console, 'error');
                new McpServerError("Test error", 400);

                expect(consoleSpy).toHaveBeenCalledWith("Error:", "Test error");
            });
        });

        describe("span integration", () => {
            it("should not set span when no active span", () => {
                vi.mocked(getActiveSpan).mockReturnValue(undefined);

                const error = new McpServerError("Test error", 400);

                expect(error.span).toBeUndefined();
                expect(getActiveSpan).toHaveBeenCalled();
            });

            it("should set span and record exception when active span exists", () => {
                const mockSpan = {
                    setStatus: vi.fn(),
                    recordException: vi.fn(),
                    setAttribute: vi.fn()
                };
                vi.mocked(getActiveSpan).mockReturnValue(mockSpan as any);

                const error = new McpServerError("Test error", 400);

                expect(error.span).toBe(mockSpan);
                expect(mockSpan.setStatus).toHaveBeenCalledWith({
                    code: SpanStatusCode.ERROR,
                    message: "Test error"
                });
                expect(mockSpan.recordException).toHaveBeenCalledWith(error);
                expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.status_code", 400);
            });

            it("should set span attributes for error object with code", () => {
                const mockSpan = {
                    setStatus: vi.fn(),
                    recordException: vi.fn(),
                    setAttribute: vi.fn()
                };
                vi.mocked(getActiveSpan).mockReturnValue(mockSpan as any);

                const errorObj = { 
                    message: "Test error", 
                    code: "ERR_001",
                    type: "ValidationError",
                    details: { field: "email", reason: "invalid format" }
                };
                const error = new McpServerError(errorObj, 400);

                expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.code", "ERR_001");
                expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.type", "ValidationError");
                expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.details", JSON.stringify(errorObj.details));
                expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.status_code", 400);
            });

            it("should not set optional span attributes when not present", () => {
                const mockSpan = {
                    setStatus: vi.fn(),
                    recordException: vi.fn(),
                    setAttribute: vi.fn()
                };
                vi.mocked(getActiveSpan).mockReturnValue(mockSpan as any);

                const errorObj = { message: "Test error" };
                const error = new McpServerError(errorObj, 400);

                expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.status_code", 400);
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith("error.code", expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith("error.type", expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith("error.details", expect.anything());
            });

            it("should handle non-object error input gracefully", () => {
                const mockSpan = {
                    setStatus: vi.fn(),
                    recordException: vi.fn(),
                    setAttribute: vi.fn()
                };
                vi.mocked(getActiveSpan).mockReturnValue(mockSpan as any);

                const error = new McpServerError("string error", 400);

                expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.status_code", 400);
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith("error.code", expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith("error.type", expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith("error.details", expect.anything());
            });
        });

        describe("toJSON method", () => {
            it("should return correct JSON representation", () => {
                const errorObj = { message: "Test error", code: "ERR_001" };
                const error = new McpServerError(errorObj, 400);

                const json = error.toJSON();

                expect(json).toEqual({
                    name: "McpServerError",
                    message: "Test error",
                    statusCode: 400,
                    errorJson: errorObj,
                    stack: expect.any(String)
                });
                expect(json.stack).toContain("McpServerError");
            });

            it("should handle string error input", () => {
                const error = new McpServerError("Simple string error", 500);

                const json = error.toJSON();

                expect(json).toEqual({
                    name: "McpServerError",
                    message: "Simple string error",
                    statusCode: 500,
                    errorJson: "Simple string error",
                    stack: expect.any(String)
                });
            });
        });

        describe("getUserMessage method", () => {
            it("should return userMessage from error object when present", () => {
                const errorObj = { 
                    message: "Technical error message", 
                    userMessage: "User-friendly error message" 
                };
                const error = new McpServerError(errorObj, 400);

                expect(error.getUserMessage()).toBe("User-friendly error message");
            });

            it("should return regular message when no userMessage present", () => {
                const errorObj = { message: "Technical error message" };
                const error = new McpServerError(errorObj, 400);

                expect(error.getUserMessage()).toBe("Technical error message");
            });

            it("should return regular message for string error input", () => {
                const error = new McpServerError("String error message", 400);

                expect(error.getUserMessage()).toBe("String error message");
            });

            it("should return regular message for non-object error input", () => {
                const error = new McpServerError(null, 400);

                expect(error.getUserMessage()).toBe("Unknown error occurred");
            });

            it("should return regular message when errorJson is object but has no userMessage", () => {
                const errorObj = { 
                    code: "ERR_001", 
                    details: "Some details", 
                    message: "Technical message" 
                };
                const error = new McpServerError(errorObj, 400);

                expect(error.getUserMessage()).toBe("Technical message");
            });
        });

        describe("instanceof checks", () => {
            it("should pass instanceof checks for Error and McpServerError", () => {
                const error = new McpServerError("Test error", 400);

                expect(error instanceof Error).toBe(true);
                expect(error instanceof McpServerError).toBe(true);
            });

            it("should maintain proper prototype chain", () => {
                const error = new McpServerError("Test error", 400);

                expect(Object.getPrototypeOf(error)).toBe(McpServerError.prototype);
                expect(Object.getPrototypeOf(Object.getPrototypeOf(error))).toBe(Error.prototype);
            });
        });

        describe("edge cases", () => {
            it("should handle empty object error input", () => {
                const error = new McpServerError({}, 400);

                expect(error.message).toBe("Unknown error occurred");
                expect(error.errorJson).toEqual({});
                expect(error.statusCode).toBe(400);
            });

            it("should handle error object with null message", () => {
                const errorObj = { message: null, code: "ERR_001" };
                const error = new McpServerError(errorObj, 400);

                expect(error.message).toBe("Unknown error occurred");
                expect(error.errorJson).toEqual(errorObj);
            });

            it("should handle error object with undefined message", () => {
                const errorObj = { message: undefined, error: "Error message" };
                const error = new McpServerError(errorObj, 400);

                expect(error.message).toBe("Error message");
                expect(error.errorJson).toEqual(errorObj);
            });

            it("should handle error object with empty string message", () => {
                const errorObj = { message: "", error: "Fallback message" };
                const error = new McpServerError(errorObj, 400);

                expect(error.message).toBe("Fallback message");
                expect(error.errorJson).toEqual(errorObj);
            });

            it("should handle error object with both message and error properties", () => {
                const errorObj = { message: "Primary message", error: "Secondary message" };
                const error = new McpServerError(errorObj, 400);

                expect(error.message).toBe("Primary message");
                expect(error.errorJson).toEqual(errorObj);
            });

            it("should handle complex nested error objects", () => {
                const errorObj = {
                    message: "Complex error",
                    code: "ERR_COMPLEX",
                    type: "ComplexError",
                    details: {
                        nested: {
                            field: "value",
                            array: [1, 2, 3]
                        }
                    }
                };
                const error = new McpServerError(errorObj, 400);

                expect(error.message).toBe("Complex error");
                expect(error.errorJson).toEqual(errorObj);
            });

            it("should handle different status codes", () => {
                const testCases = [200, 400, 401, 403, 404, 500, 502, 503];
                
                for (const statusCode of testCases) {
                    const error = new McpServerError("Test error", statusCode);
                    expect(error.statusCode).toBe(statusCode);
                    expect(error.message).toBe("Test error");
                }
            });
        });
    });
}); 
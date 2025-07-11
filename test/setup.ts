import { vi } from "vitest";

// Mock process.env to prevent Node.js module imports
vi.stubGlobal('process', {
    env: {
        HONEYCOMB_API_KEY: 'test-key',
        HONEYCOMB_DATASET: 'test-dataset'
    }
});

// Mock OpenTelemetry API to prevent Node.js module imports
vi.mock('@opentelemetry/api', () => {
    const mockSpan = {
        setAttribute: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
        setAttributes: vi.fn(),
        setStatus: vi.fn(),
        updateName: vi.fn(),
        addEvent: vi.fn(),
        isRecording: vi.fn(() => true),
        spanContext: vi.fn(() => ({ traceId: '123', spanId: '456' }))
    };
    
    const mockTracer = {
        startActiveSpan: vi.fn((name, fn) => {
            return fn(mockSpan);
        }),
        startSpan: vi.fn(() => mockSpan)
    };
    
    return {
        trace: {
            getActiveSpan: vi.fn(() => mockSpan),
            setSpan: vi.fn(),
            getSpan: vi.fn(() => mockSpan),
            deleteSpan: vi.fn(),
            setSpanContext: vi.fn(),
            getSpanContext: vi.fn(),
            getTracer: vi.fn(() => mockTracer)
        },
        context: {
            active: vi.fn(() => ({})),
            with: vi.fn((ctx, fn) => fn()),
            bind: vi.fn()
        },
        SpanStatusCode: {
            OK: 1,
            ERROR: 2
        }
    };
});

// Mock agents/mcp to prevent OpenTelemetry resource loading
vi.mock('agents/mcp', () => {
    return {
        McpAgent: class MockMcpAgent {
            server: any;
            constructor(state: any, env: any) {
                this.server = { init: vi.fn() };
            }
            async init() {
                return Promise.resolve();
            }
        }
    };
});

// Mock @opentelemetry/resources with hoisted functions
const mockResource = vi.hoisted(() => {
    return class MockResource {
        attributes: Record<string, any>;
        
        constructor(attributes: Record<string, any> = {}) {
            this.attributes = attributes;
        }
        
        static default() {
            return new MockResource();
        }
        
        static empty() {
            return new MockResource();
        }
        
        merge(other: any) {
            return new MockResource({ ...this.attributes, ...other.attributes });
        }
    };
});

const mockDetectResources = vi.hoisted(() => {
    return vi.fn(() => Promise.resolve(new mockResource()));
});

const mockDetector = vi.hoisted(() => {
    return {
        detect: vi.fn(() => Promise.resolve(new mockResource())),
    };
});

vi.mock('@opentelemetry/resources', () => {
    return {
        Resource: mockResource,
        detectResources: mockDetectResources,
        envDetector: mockDetector,
        hostDetector: mockDetector,
        osDetector: mockDetector,
        processDetector: mockDetector,
    };
});

// Mock @microlabs/otel-cf-workers with hoisted functions
const mockInstrumentDO = vi.hoisted(() => {
    return (cls: any, config: any) => {
        // Create a mock class that extends the original
        class MockInstrumentedClass extends cls {
            static serve = vi.fn((path: string) => ({
                fetch: vi.fn().mockResolvedValue(new Response('Mock MCP Response', { status: 200 }))
            }));
            static serveSSE = vi.fn((path: string) => ({
                fetch: vi.fn().mockResolvedValue(new Response('Mock SSE Response', { status: 200 }))
            }));
        }
        
        // Add static methods to the class itself
        MockInstrumentedClass.serve = vi.fn((path: string) => ({
            fetch: vi.fn().mockResolvedValue(new Response('Mock MCP Response', { status: 200 }))
        }));
        MockInstrumentedClass.serveSSE = vi.fn((path: string) => ({
            fetch: vi.fn().mockResolvedValue(new Response('Mock SSE Response', { status: 200 }))
        }));
        
        return MockInstrumentedClass;
    };
});

const mockInstrument = vi.hoisted(() => {
    return (handler: any, config: any) => {
        // Return the handler as-is for testing, ensuring it has a fetch method
        return {
            fetch: handler.fetch || vi.fn().mockResolvedValue(new Response('Mock Response', { status: 200 })),
            ...handler
        };
    };
});

vi.mock('@microlabs/otel-cf-workers', async (importOriginal) => {
    const original = await importOriginal();
    return {
        instrument: mockInstrument,
        instrumentDO: mockInstrumentDO,
        ResolveConfigFn: vi.fn(),
    };
}); 
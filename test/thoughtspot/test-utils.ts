import { expect, vi } from 'vitest';
import type { Mock } from 'vitest';

// Test utilities for ThoughtSpot client tests

export interface MockFetchResponse {
  ok?: boolean;
  status?: number;
  json: Mock;
  text?: Mock;
}

export interface MockContext {
  getHeaders: Mock;
  setHeaderParam: Mock;
}

/**
 * Creates a mock fetch response
 */
export function createMockFetchResponse(
  data: any,
  options: { ok?: boolean; status?: number } = {}
): MockFetchResponse {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

/**
 * Creates a mock request context for middleware testing
 */
export function createMockRequestContext(headers: Record<string, string> = {}): MockContext {
  return {
    getHeaders: vi.fn().mockReturnValue(headers),
    setHeaderParam: vi.fn(),
  };
}

/**
 * Creates a mock response context for middleware testing
 */
export function createMockResponseContext(): any {
  return {
    // Add any response context properties as needed
  };
}

/**
 * Validates that a fetch call was made with the expected parameters
 */
export function validateFetchCall(
  fetchMock: Mock,
  expectedUrl: string,
  expectedOptions: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
) {
  expect(fetchMock).toHaveBeenCalledWith(
    expectedUrl,
    expect.objectContaining({
      method: expectedOptions.method || 'GET',
      headers: expect.objectContaining(expectedOptions.headers || {}),
      ...(expectedOptions.body && { body: expectedOptions.body }),
    })
  );
}

/**
 * Validates TML data structure
 */
export function validateTMLData(tmlData: any) {
  expect(tmlData).toBeDefined();
  expect(typeof tmlData).toBe('object');
  
  // Basic TML structure validation
  if (tmlData.guid) {
    expect(typeof tmlData.guid).toBe('string');
  }
  
  if (tmlData.type) {
    expect(typeof tmlData.type).toBe('string');
  }
  
  if (tmlData.name) {
    expect(typeof tmlData.name).toBe('string');
  }
}

/**
 * Validates session info data structure
 */
export function validateSessionInfo(sessionInfo: any) {
  expect(sessionInfo).toBeDefined();
  expect(typeof sessionInfo).toBe('object');
  
  // Basic session info validation
  if (sessionInfo.userId) {
    expect(typeof sessionInfo.userId).toBe('string');
  }
  
  if (sessionInfo.userName) {
    expect(typeof sessionInfo.userName).toBe('string');
  }
}

/**
 * Waits for a specified amount of time (useful for async operations)
 */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a test client with mocked dependencies
 */
export function createTestClient(instanceUrl: string, bearerToken: string): any {
  // This would be used in integration tests or when you want to test
  // the actual client creation without mocking
  const { getThoughtSpotClient } = require('../../src/thoughtspot/thoughtspot-client');
  return getThoughtSpotClient(instanceUrl, bearerToken);
}

/**
 * Validates GraphQL query structure
 */
export function validateGraphQLQuery(query: string) {
  expect(query).toContain('mutation');
  expect(query).toContain('GetUnsavedAnswerTML');
  expect(query).toContain('BachSessionIdInput');
  expect(query).toContain('UnsavedAnswer_getTML');
  expect(query).toContain('edoc');
}

/**
 * Validates request payload structure
 */
export function validateRequestPayload(payload: any) {
  expect(payload).toHaveProperty('token');
  expect(payload).toHaveProperty('clusterUrl');
  expect(payload).toHaveProperty('endpoint');
  expect(payload).toHaveProperty('payload');
  expect(payload.payload).toHaveProperty('operationName');
  expect(payload.payload).toHaveProperty('query');
  expect(payload.payload).toHaveProperty('variables');
}

/**
 * Creates a mock error response
 */
export function createMockErrorResponse(
  message: string,
  code?: string,
  status = 400
): MockFetchResponse {
  const errorData = {
    errors: [
      {
        message,
        code: code || 'ERROR',
        path: ['UnsavedAnswer_getTML']
      }
    ]
  };
  
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue(errorData),
    text: vi.fn().mockResolvedValue(JSON.stringify(errorData)),
  };
}

/**
 * Validates middleware behavior
 */
export async function validateMiddleware(
  middleware: any,
  context: any,
  expectedHeader?: string,
  expectedValue?: string
) {
  const result = await middleware.pre(context).toPromise();
  
  expect(result).toBe(context);
  
  if (expectedHeader && expectedValue) {
    expect(context.setHeaderParam).toHaveBeenCalledWith(expectedHeader, expectedValue);
  }
}

/**
 * Performance testing utility
 */
export async function measurePerformance<T>(
  operation: () => Promise<T>,
  maxDuration = 5000
): Promise<{ result: T; duration: number }> {
  const startTime = Date.now();
  const result = await operation();
  const endTime = Date.now();
  const duration = endTime - startTime;
  
  expect(duration).toBeLessThan(maxDuration);
  
  return { result, duration };
}

/**
 * Concurrent testing utility
 */
export async function testConcurrentOperations<T>(
  operation: () => Promise<T>,
  count = 3,
  timeout = 30000
): Promise<T[]> {
  const promises = Array(count).fill(null).map(() => operation());
  const results = await Promise.all(promises);
  
  expect(results).toHaveLength(count);
  for (const result of results) {
    expect(result).toBeDefined();
  }
  
  return results;
} 
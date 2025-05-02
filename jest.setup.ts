import { jest } from '@jest/globals';
import { mockCloudflareEnvironment } from './src/__tests__/mocks/cloudflare';

// Mock Cloudflare Workers environment
jest.mock('cloudflare:workers', () => mockCloudflareEnvironment, { virtual: true });

// Setup global fetch mock
global.fetch = jest.fn().mockImplementation(() =>
    Promise.resolve(new Response())
) as unknown as typeof fetch;

// Clear all mocks before each test
beforeEach(() => {
    jest.clearAllMocks();
}); 
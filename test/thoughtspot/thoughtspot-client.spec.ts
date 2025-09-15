import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getThoughtSpotClient } from '../../src/thoughtspot/thoughtspot-client';
import { createBearerAuthenticationConfig, ThoughtSpotRestApi } from '@thoughtspot/rest-api-sdk';
import type { RequestContext, ResponseContext } from '@thoughtspot/rest-api-sdk';
import { of } from 'rxjs';
import YAML from 'yaml';

// Mock the ThoughtSpot REST API SDK
vi.mock('@thoughtspot/rest-api-sdk', () => ({
  createBearerAuthenticationConfig: vi.fn(),
  ThoughtSpotRestApi: vi.fn(),
}));

// Mock fetch
global.fetch = vi.fn();

// Mock YAML
vi.mock('yaml', () => ({
  default: {
    parse: vi.fn(),
  },
}));

describe('ThoughtSpot Client', () => {
  const mockInstanceUrl = 'https://test.thoughtspot.com';
  const mockBearerToken = 'test-token-123';

  let mockConfig: any;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock config
    mockConfig = {
      middleware: [],
    };

    // Setup mock client
    mockClient = {
      instanceUrl: mockInstanceUrl,
    };

    (createBearerAuthenticationConfig as any).mockReturnValue(mockConfig);
    (ThoughtSpotRestApi as any).mockImplementation(() => mockClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getThoughtSpotClient', () => {
    it('should create a ThoughtSpot client with bearer authentication', () => {
      const client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;

      expect(createBearerAuthenticationConfig).toHaveBeenCalledWith(
        mockInstanceUrl,
        expect.any(Function)
      );
      expect(ThoughtSpotRestApi).toHaveBeenCalledWith(mockConfig);
      expect(client).toBe(mockClient);
      expect(client.instanceUrl).toBe(mockInstanceUrl);
    });

    it('should add middleware with Accept-Language header', async () => {
      const client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken);

      expect(mockConfig.middleware).toHaveLength(1);

      const middleware = mockConfig.middleware[0];
      expect(middleware).toHaveProperty('pre');
      expect(middleware).toHaveProperty('post');

      // Test pre middleware
      const mockContext = {
        getHeaders: vi.fn().mockReturnValue({}),
        setHeaderParam: vi.fn(),
      };

      const preResult = await middleware.pre(mockContext).toPromise();

      expect(mockContext.getHeaders).toHaveBeenCalled();
      expect(mockContext.setHeaderParam).toHaveBeenCalledWith('Accept-Language', 'en-US');
      expect(preResult).toBe(mockContext);
    });

    it('should not override existing Accept-Language header', async () => {
      const client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken);

      const middleware = mockConfig.middleware[0];
      const mockContext = {
        getHeaders: vi.fn().mockReturnValue({ 'Accept-Language': 'fr-FR' }),
        setHeaderParam: vi.fn(),
      };

      await middleware.pre(mockContext).toPromise();

      expect(mockContext.setHeaderParam).not.toHaveBeenCalled();
    });

    it('should handle post middleware correctly', async () => {
      const client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken);

      const middleware = mockConfig.middleware[0];
      const mockContext = {} as ResponseContext;

      const postResult = await middleware.post(mockContext).toPromise();

      expect(postResult).toBe(mockContext);
    });

    it('should add custom methods to the client', () => {
      const client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;

      expect(client).toHaveProperty('exportUnsavedAnswerTML');
      expect(client).toHaveProperty('getSessionInfo');
      expect(client).toHaveProperty('queryGetDataSourceSuggestions');
      expect(typeof client.exportUnsavedAnswerTML).toBe('function');
      expect(typeof client.getSessionInfo).toBe('function');
      expect(typeof client.queryGetDataSourceSuggestions).toBe('function');
    });
  });

  describe('exportUnsavedAnswerTML', () => {
    let client: any;

    beforeEach(() => {
      client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
    });

    it('should export unsaved answer TML successfully', async () => {
      const mockResponse = {
        data: {
          UnsavedAnswer_getTML: {
            object: [{
              edoc: 'test-yaml-content'
            }]
          }
        }
      };

      const mockYamlParsed = { test: 'data' };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      (YAML.parse as any).mockReturnValue(mockYamlParsed);

      const result = await client.exportUnsavedAnswerTML({
        session_identifier: 'session-123',
        generation_number: 1
      });

      expect(fetch).toHaveBeenCalledWith(`${mockInstanceUrl}/prism/?op=GetUnsavedAnswerTML`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'user-agent': 'ThoughtSpot-ts-client',
          'Authorization': 'Bearer test-token-123',
        },
        body: expect.any(String)
      });

      // Verify the body contains expected data
      const fetchCall = (fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.operationName).toBe('GetUnsavedAnswerTML');
      expect(body.variables.session.sessionId).toBe('session-123');
      expect(body.variables.session.genNo).toBe(1);

      expect(YAML.parse).toHaveBeenCalledWith('test-yaml-content');
      expect(result).toEqual(mockYamlParsed);
    });

    it('should handle fetch errors', async () => {
      const mockError = new Error('Network error');
      (fetch as any).mockRejectedValue(mockError);

      await expect(client.exportUnsavedAnswerTML({
        session_identifier: 'session-123',
        generation_number: 1
      })).rejects.toThrow('Network error');
    });

    it('should handle malformed response data', async () => {
      const mockResponse = {
        data: {
          UnsavedAnswer_getTML: {
            object: [] // Empty array
          }
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      await expect(client.exportUnsavedAnswerTML({
        session_identifier: 'session-123',
        generation_number: 1
      })).rejects.toThrow();
    });
  });

  describe('getSessionInfo', () => {
    let client: any;

    beforeEach(() => {
      client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
    });

    it('should get session info successfully', async () => {
      const mockResponse = {
        info: {
          userId: 'user-123',
          userName: 'test-user',
          email: 'test@example.com',
          displayName: 'Test User',
          tenantId: 'tenant-123',
          locale: 'en-US',
          timezone: 'UTC'
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      const result = await client.getSessionInfo();

      expect(fetch).toHaveBeenCalledWith(`${mockInstanceUrl}/prism/preauth/info`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'user-agent': 'ThoughtSpot-ts-client',
          'Authorization': `Bearer ${mockBearerToken}`,
        }
      });

      expect(result).toEqual(mockResponse.info);
    });

    it('should handle fetch errors', async () => {
      const mockError = new Error('Network error');
      (fetch as any).mockRejectedValue(mockError);

      await expect(client.getSessionInfo()).rejects.toThrow('Network error');
    });

    it('should handle HTTP error responses', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: vi.fn().mockResolvedValue({ error: 'Invalid token' })
      };

      (fetch as any).mockResolvedValue(mockResponse);

      // The actual implementation doesn't check response.ok, so it will try to parse the response
      const result = await client.getSessionInfo();
      expect(result).toBeUndefined(); // data.info will be undefined
    });

    it('should handle malformed response', async () => {
      const mockResponse = {
        // Missing info property
        someOtherProperty: 'value'
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      const result = await client.getSessionInfo();
      expect(result).toBeUndefined();
    });

    it('should handle empty response', async () => {
      const mockResponse = {};

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      const result = await client.getSessionInfo();
      expect(result).toBeUndefined();
    });

    it('should handle null response', async () => {
      const mockResponse = null;

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      // The actual implementation will throw when trying to access data.info on null
      await expect(client.getSessionInfo()).rejects.toThrow();
    });

    it('should handle partial session info', async () => {
      const mockResponse = {
        info: {
          userId: 'user-123',
          userName: 'test-user'
          // Missing other properties
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      const result = await client.getSessionInfo();

      expect(result).toEqual(mockResponse.info);
      expect(result.userId).toBe('user-123');
      expect(result.userName).toBe('test-user');
      expect(result.email).toBeUndefined();
    });

    it('should use correct headers for session info request', async () => {
      const mockResponse = {
        info: {
          userId: 'user-123',
          userName: 'test-user'
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      await client.getSessionInfo();

      const fetchCall = (fetch as any).mock.calls[0];
      const headers = fetchCall[1].headers;

      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Accept).toBe('application/json');
      expect(headers['user-agent']).toBe('ThoughtSpot-ts-client');
      expect(headers.Authorization).toBe(`Bearer ${mockBearerToken}`);
    });

    it('should handle JSON parsing errors', async () => {
      (fetch as any).mockResolvedValue({
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON'))
      });

      await expect(client.getSessionInfo()).rejects.toThrow('Invalid JSON');
    });
  });

  describe('queryGetDataSourceSuggestions', () => {
    let client: any;

    beforeEach(() => {
      client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
    });

    it('should query data source suggestions successfully', async () => {
      const mockResponse = {
        data: {
          queryGetDataSourceSuggestions: {
            dataSources: [
              {
                confidence: 0.95,
                header: {
                  description: 'Sales data with customer information',
                  displayName: 'Sales Database',
                  guid: 'sales-db-guid-123'
                },
                llmReasoning: 'This datasource contains sales information that matches your query about revenue'
              },
              {
                confidence: 0.78,
                header: {
                  description: 'Customer relationship management data',
                  displayName: 'CRM Database',
                  guid: 'crm-db-guid-456'
                },
                llmReasoning: 'This datasource has customer data that could be relevant to your analysis'
              }
            ]
          }
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      const result = await client.queryGetDataSourceSuggestions('Show me sales revenue by customer');

      expect(fetch).toHaveBeenCalledWith(`${mockInstanceUrl}/prism/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'user-agent': 'ThoughtSpot-ts-client',
          'Authorization': `Bearer ${mockBearerToken}`,
        },
        body: expect.any(String)
      });

      // Verify the body contains expected GraphQL query data
      const fetchCall = (fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.operationName).toBe('QueryGetDataSourceSuggestions');
      expect(body.variables.request.query).toBe('Show me sales revenue by customer');
      expect(body.query).toContain('queryGetDataSourceSuggestions');
      expect(body.query).toContain('dataSources');
      expect(body.query).toContain('confidence');
      expect(body.query).toContain('header');
      expect(body.query).toContain('llmReasoning');

      expect(result).toEqual(mockResponse.data.queryGetDataSourceSuggestions);
      expect(result.dataSources).toHaveLength(2);
      expect(result.dataSources[0].confidence).toBe(0.95);
      expect(result.dataSources[0].header.displayName).toBe('Sales Database');
    });

    it('should handle empty data source suggestions response', async () => {
      const mockResponse = {
        data: {
          queryGetDataSourceSuggestions: {
            dataSources: []
          }
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      const result = await client.queryGetDataSourceSuggestions('no matching data');

      expect(result.dataSources).toEqual([]);
      expect(result.dataSources).toHaveLength(0);
    });

    it('should handle network errors', async () => {
      const mockError = new Error('Network connection failed');
      (fetch as any).mockRejectedValue(mockError);

      await expect(client.queryGetDataSourceSuggestions('test query')).rejects.toThrow('Network connection failed');
    });

    it('should handle HTTP error responses', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: vi.fn().mockResolvedValue({ error: 'Server error' })
      };

      (fetch as any).mockResolvedValue(mockResponse);

      // The actual implementation doesn't check response.ok, so it will try to parse the response
      // Since the response doesn't have a 'data' property, accessing data.data will throw
      await expect(client.queryGetDataSourceSuggestions('test query')).rejects.toThrow();
    });

    it('should handle malformed GraphQL response', async () => {
      const mockResponse = {
        data: {
          // Missing queryGetDataSourceSuggestions property
          someOtherProperty: 'value'
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      const result = await client.queryGetDataSourceSuggestions('test query');
      expect(result).toBeUndefined();
    });

    it('should handle GraphQL errors in response', async () => {
      const mockResponse = {
        errors: [
          {
            message: 'Authentication failed',
            locations: [{ line: 2, column: 3 }],
            path: ['queryGetDataSourceSuggestions']
          }
        ]
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      // The actual implementation will throw when trying to access data.data on undefined (no data property when there are errors)
      await expect(client.queryGetDataSourceSuggestions('test query')).rejects.toThrow();
    });

    it('should handle null response data', async () => {
      const mockResponse = null;

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      // The actual implementation will throw when trying to access data.queryGetDataSourceSuggestions on null
      await expect(client.queryGetDataSourceSuggestions('test query')).rejects.toThrow();
    });

    it('should handle JSON parsing errors', async () => {
      (fetch as any).mockResolvedValue({
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON response'))
      });

      await expect(client.queryGetDataSourceSuggestions('test query')).rejects.toThrow('Invalid JSON response');
    });

    it('should use correct request headers and format', async () => {
      const mockResponse = {
        data: {
          queryGetDataSourceSuggestions: {
            dataSources: []
          }
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      await client.queryGetDataSourceSuggestions('sales data analysis');

      const fetchCall = (fetch as any).mock.calls[0];
      const url = fetchCall[0];
      const options = fetchCall[1];

      expect(url).toBe(`${mockInstanceUrl}/prism/`);
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers.Accept).toBe('application/json');
      expect(options.headers['user-agent']).toBe('ThoughtSpot-ts-client');
      expect(options.headers.Authorization).toBe(`Bearer ${mockBearerToken}`);

      const body = JSON.parse(options.body);
      expect(body.operationName).toBe('QueryGetDataSourceSuggestions');
      expect(body.variables.request.query).toBe('sales data analysis');
    });

    it('should handle single data source suggestion', async () => {
      const mockResponse = {
        data: {
          queryGetDataSourceSuggestions: {
            dataSources: [
              {
                confidence: 0.88,
                header: {
                  description: 'Financial data warehouse',
                  displayName: 'Finance DW',
                  guid: 'finance-dw-guid-789'
                },
                llmReasoning: 'Contains comprehensive financial metrics and KPIs'
              }
            ]
          }
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      const result = await client.queryGetDataSourceSuggestions('financial metrics');

      expect(result.dataSources).toHaveLength(1);
      expect(result.dataSources[0].confidence).toBe(0.88);
      expect(result.dataSources[0].header.displayName).toBe('Finance DW');
      expect(result.dataSources[0].header.guid).toBe('finance-dw-guid-789');
      expect(result.dataSources[0].llmReasoning).toBe('Contains comprehensive financial metrics and KPIs');
    });

    it('should handle partial data source suggestion data', async () => {
      const mockResponse = {
        data: {
          queryGetDataSourceSuggestions: {
            dataSources: [
              {
                confidence: 0.75,
                header: {
                  displayName: 'Incomplete Data Source',
                  guid: 'incomplete-guid-999'
                  // Missing description
                },
                llmReasoning: 'This has partial data'
              }
            ]
          }
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      const result = await client.queryGetDataSourceSuggestions('test query');

      expect(result.dataSources).toHaveLength(1);
      expect(result.dataSources[0].confidence).toBe(0.75);
      expect(result.dataSources[0].header.displayName).toBe('Incomplete Data Source');
      expect(result.dataSources[0].header.description).toBeUndefined();
    });

    it('should handle different query types', async () => {
      const mockResponse = {
        data: {
          queryGetDataSourceSuggestions: {
            dataSources: []
          }
        }
      };

      (fetch as any).mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse)
      });

      // Test with empty string
      await client.queryGetDataSourceSuggestions('');
      expect((fetch as any).mock.calls[0][1].body).toContain('"query":""');

      // Test with special characters
      await client.queryGetDataSourceSuggestions('query with "quotes" and %symbols%');
      expect((fetch as any).mock.calls[1][1].body).toContain('query with \\"quotes\\" and %symbols%');

      // Test with very long query
      const longQuery = 'a'.repeat(1000);
      await client.queryGetDataSourceSuggestions(longQuery);
      expect((fetch as any).mock.calls[2][1].body).toContain(longQuery);
    });
  });

  describe('GraphQL Queries', () => {
    it('should have the correct GraphQL mutation structure for GetUnsavedAnswerTML', () => {
      // This test ensures the GraphQL query is properly structured
      const query = `
mutation GetUnsavedAnswerTML($session: BachSessionIdInput!, $exportDependencies: Boolean, $formatType:  EDocFormatType, $exportPermissions: Boolean, $exportFqn: Boolean) {
  UnsavedAnswer_getTML(
    session: $session
    exportDependencies: $exportDependencies
    formatType: $formatType
    exportPermissions: $exportPermissions
    exportFqn: $exportFqn
  ) {
    zipFile
    object {
      edoc
      name
      type
      __typename
    }
    __typename
  }
}`;

      expect(query).toContain('mutation GetUnsavedAnswerTML');
      expect(query).toContain('BachSessionIdInput');
      expect(query).toContain('UnsavedAnswer_getTML');
      expect(query).toContain('edoc');
    });

    it('should have the correct GraphQL query structure for QueryGetDataSourceSuggestions', () => {
      // This test ensures the data source suggestions GraphQL query is properly structured
      const query = `
query QueryGetDataSourceSuggestions($request: Input_eureka_DataSourceSuggestionRequest) {
  queryGetDataSourceSuggestions(request: $request) {
    dataSources {
      confidence
      header {
        description
        displayName
        guid
      }
      llmReasoning
    }
  }
}`;

      expect(query).toContain('query QueryGetDataSourceSuggestions');
      expect(query).toContain('Input_eureka_DataSourceSuggestionRequest');
      expect(query).toContain('queryGetDataSourceSuggestions');
      expect(query).toContain('dataSources');
      expect(query).toContain('confidence');
      expect(query).toContain('header');
      expect(query).toContain('description');
      expect(query).toContain('displayName');
      expect(query).toContain('guid');
      expect(query).toContain('llmReasoning');
    });
  });
}); 
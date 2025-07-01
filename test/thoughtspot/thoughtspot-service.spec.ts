import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ThoughtSpotRestApi } from '@thoughtspot/rest-api-sdk';
import {
  getRelevantQuestions,
  getAnswerForQuestion,
  fetchTMLAndCreateLiveboard,
  createLiveboard,
  getDataSources,
  getSessionInfo,
  type DataSource,
  type SessionInfo
} from '../../src/thoughtspot/thoughtspot-service';

// Mock the ThoughtSpot REST API client
const mockClient = {
  queryGetDecomposedQuery: vi.fn(),
  singleAnswer: vi.fn(),
  exportAnswerReport: vi.fn(),
  exportUnsavedAnswerTML: vi.fn(),
  importMetadataTML: vi.fn(),
  searchMetadata: vi.fn(),
  getSessionInfo: vi.fn(),
  instanceUrl: 'https://test.thoughtspot.com'
} as unknown as ThoughtSpotRestApi;

describe('thoughtspot-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    console.error = vi.fn(); // Mock console.error to avoid noise in tests
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getRelevantQuestions', () => {
    it('should return relevant questions successfully', async () => {
      const mockResponse = {
        decomposedQueryResponse: {
          decomposedQueries: [
            { query: 'What is the total revenue?', worksheetId: 'ws1' },
            { query: 'Show me sales by region', worksheetId: 'ws2' }
          ]
        }
      };

      mockClient.queryGetDecomposedQuery = vi.fn().mockResolvedValue(mockResponse);

      const result = await getRelevantQuestions(
        'Show me revenue data',
        ['ws1', 'ws2'],
        'Additional context',
        mockClient
      );

      expect(mockClient.queryGetDecomposedQuery).toHaveBeenCalledWith({
        nlsRequest: {
          query: 'Show me revenue data',
        },
        content: ['Additional context'],
        worksheetIds: ['ws1', 'ws2'],
        maxDecomposedQueries: 5,
      });

      expect(result).toEqual({
        questions: [
          { question: 'What is the total revenue?', datasourceId: 'ws1' },
          { question: 'Show me sales by region', datasourceId: 'ws2' }
        ],
        error: null,
      });
    });

    it('should handle empty additional context', async () => {
      const mockResponse = {
        decomposedQueryResponse: {
          decomposedQueries: []
        }
      };

      mockClient.queryGetDecomposedQuery = vi.fn().mockResolvedValue(mockResponse);

      const result = await getRelevantQuestions(
        'Test query',
        ['ws1'],
        '',
        mockClient
      );

      expect(mockClient.queryGetDecomposedQuery).toHaveBeenCalledWith({
        nlsRequest: {
          query: 'Test query',
        },
        content: [''],
        worksheetIds: ['ws1'],
        maxDecomposedQueries: 5,
      });

      expect(result).toEqual({
        questions: [],
        error: null,
      });
    });

    it('should handle null additional context', async () => {
      const mockResponse = {
        decomposedQueryResponse: {
          decomposedQueries: []
        }
      };

      mockClient.queryGetDecomposedQuery = vi.fn().mockResolvedValue(mockResponse);

      const result = await getRelevantQuestions(
        'Test query',
        ['ws1'],
        null as any,
        mockClient
      );

      expect(mockClient.queryGetDecomposedQuery).toHaveBeenCalledWith({
        nlsRequest: {
          query: 'Test query',
        },
        content: [''],
        worksheetIds: ['ws1'],
        maxDecomposedQueries: 5,
      });

      expect(result).toEqual({
        questions: [],
        error: null,
      });
    });

    it('should handle missing decomposedQueryResponse', async () => {
      const mockResponse = {};

      mockClient.queryGetDecomposedQuery = vi.fn().mockResolvedValue(mockResponse);

      const result = await getRelevantQuestions(
        'Test query',
        ['ws1'],
        'context',
        mockClient
      );

      expect(result).toEqual({
        questions: [],
        error: null,
      });
    });

    it('should handle API errors', async () => {
      const error = new Error('API Error');
      mockClient.queryGetDecomposedQuery = vi.fn().mockRejectedValue(error);

      const result = await getRelevantQuestions(
        'Test query',
        ['ws1'],
        'context',
        mockClient
      );

      expect(result).toEqual({
        questions: [],
        error: error,
      });
    });
  });

  describe('getAnswerForQuestion', () => {
    it('should return answer data successfully without TML', async () => {
      const mockAnswerResponse = {
        session_identifier: 'session123',
        generation_number: 1
      };

      const mockDataResponse = {
        text: vi.fn().mockResolvedValue('col1,col2\nval1,val2\nval3,val4')
      };

      mockClient.singleAnswer = vi.fn().mockResolvedValue(mockAnswerResponse);
      mockClient.exportAnswerReport = vi.fn().mockResolvedValue(mockDataResponse);

      const result = await getAnswerForQuestion(
        'What is the revenue?',
        'ws1',
        false,
        mockClient
      );

      expect(mockClient.singleAnswer).toHaveBeenCalledWith({
        query: 'What is the revenue?',
        metadata_identifier: 'ws1',
      });

      expect(mockClient.exportAnswerReport).toHaveBeenCalledWith({
        session_identifier: 'session123',
        generation_number: 1,
        file_format: 'CSV',
      });

      expect(result).toEqual({
        question: 'What is the revenue?',
        ...mockAnswerResponse,
        data: 'col1,col2\nval1,val2\nval3,val4',
        tml: null,
        error: null,
      });
    });

    it('should return answer data with TML when requested', async () => {
      const mockAnswerResponse = {
        session_identifier: 'session123',
        generation_number: 1
      };

      const mockDataResponse = {
        text: vi.fn().mockResolvedValue('col1,col2\nval1,val2')
      };

      const mockTMLResponse = { answer: { name: 'Test Answer' } };

      mockClient.singleAnswer = vi.fn().mockResolvedValue(mockAnswerResponse);
      mockClient.exportAnswerReport = vi.fn().mockResolvedValue(mockDataResponse);
      (mockClient as any).exportUnsavedAnswerTML = vi.fn().mockResolvedValue(mockTMLResponse);

      const result = await getAnswerForQuestion(
        'What is the revenue?',
        'ws1',
        true,
        mockClient
      );

      expect((mockClient as any).exportUnsavedAnswerTML).toHaveBeenCalledWith({
        session_identifier: 'session123',
        generation_number: 1,
      });

      expect(result).toEqual({
        question: 'What is the revenue?',
        ...mockAnswerResponse,
        data: 'col1,col2\nval1,val2',
        tml: mockTMLResponse,
        error: null,
      });
    });

    it('should limit CSV data to 100 lines', async () => {
      const mockAnswerResponse = {
        session_identifier: 'session123',
        generation_number: 1
      };

      // Create CSV with more than 100 lines
      const longCSV = Array.from({ length: 150 }, (_, i) => `col1,col2\nval${i},val${i}`).join('\n');
      const mockDataResponse = {
        text: vi.fn().mockResolvedValue(longCSV)
      };

      mockClient.singleAnswer = vi.fn().mockResolvedValue(mockAnswerResponse);
      mockClient.exportAnswerReport = vi.fn().mockResolvedValue(mockDataResponse);

      const result = await getAnswerForQuestion(
        'What is the revenue?',
        'ws1',
        false,
        mockClient
      );

      // Type guard to check if result has data property
      if ('data' in result && result.data) {
        const lines = result.data.split('\n');
        expect(lines.length).toBeLessThanOrEqual(100);
      } else {
        expect.fail('Expected result to have data property');
      }
    });

    it('should handle TML export errors gracefully', async () => {
      const mockAnswerResponse = {
        session_identifier: 'session123',
        generation_number: 1
      };

      const mockDataResponse = {
        text: vi.fn().mockResolvedValue('col1,col2\nval1,val2')
      };

      mockClient.singleAnswer = vi.fn().mockResolvedValue(mockAnswerResponse);
      mockClient.exportAnswerReport = vi.fn().mockResolvedValue(mockDataResponse);
      (mockClient as any).exportUnsavedAnswerTML = vi.fn().mockRejectedValue(new Error('TML Error'));

      const result = await getAnswerForQuestion(
        'What is the revenue?',
        'ws1',
        true,
        mockClient
      );

      expect(result).toEqual({
        question: 'What is the revenue?',
        ...mockAnswerResponse,
        data: 'col1,col2\nval1,val2',
        tml: null,
        error: null,
      });
    });

    it('should handle API errors', async () => {
      const error = new Error('API Error');
      mockClient.singleAnswer = vi.fn().mockRejectedValue(error);

      const result = await getAnswerForQuestion(
        'What is the revenue?',
        'ws1',
        false,
        mockClient
      );

      expect(result).toEqual({
        error: error,
      });
    });
  });

  describe('fetchTMLAndCreateLiveboard', () => {
    it('should fetch TML and create liveboard successfully', async () => {
      const answers = [
        {
          question: 'Question 1',
          session_identifier: 'session1',
          generation_number: 1
        },
        {
          question: 'Question 2',
          session_identifier: 'session2',
          generation_number: 1
        }
      ];

      const mockTML1 = { answer: { name: 'Answer 1' } };
      const mockTML2 = { answer: { name: 'Answer 2' } };

      (mockClient as any).exportUnsavedAnswerTML = vi.fn()
        .mockResolvedValueOnce(mockTML1)
        .mockResolvedValueOnce(mockTML2);

      mockClient.importMetadataTML = vi.fn().mockResolvedValue([
        { response: { header: { id_guid: 'liveboard123' } } }
      ]);

      const result = await fetchTMLAndCreateLiveboard('Test Liveboard', answers, mockClient);

      expect((mockClient as any).exportUnsavedAnswerTML).toHaveBeenCalledTimes(2);
      expect(mockClient.importMetadataTML).toHaveBeenCalledWith({
        metadata_tmls: [expect.any(String)],
        import_policy: 'ALL_OR_NONE',
      });

      expect(result).toEqual({
        url: 'https://test.thoughtspot.com/#/pinboard/liveboard123',
        error: null,
      });
    });

    it('should handle TML fetch errors', async () => {
      const answers = [
        {
          question: 'Question 1',
          session_identifier: 'session1',
          generation_number: 1
        }
      ];

      (mockClient as any).exportUnsavedAnswerTML = vi.fn().mockRejectedValue(new Error('TML Error'));

      const result = await fetchTMLAndCreateLiveboard('Test Liveboard', answers, mockClient);

      expect(result).toEqual({
        liveboardUrl: null,
        error: expect.any(Error),
      });
    });
  });

  describe('createLiveboard', () => {
    it('should create liveboard with valid TML data', async () => {
      const answers = [
        {
          question: 'Question 1',
          tml: { answer: { name: 'Answer 1', content: 'test' } }
        },
        {
          question: 'Question 2',
          tml: { answer: { name: 'Answer 2', content: 'test' } }
        }
      ];

      mockClient.importMetadataTML = vi.fn().mockResolvedValue([
        { response: { header: { id_guid: 'liveboard123' } } }
      ]);

      const result = await createLiveboard('Test Liveboard', answers, mockClient);

      expect(mockClient.importMetadataTML).toHaveBeenCalledWith({
        metadata_tmls: [expect.stringContaining('"liveboard"')],
        import_policy: 'ALL_OR_NONE',
      });

      expect(result).toBe('https://test.thoughtspot.com/#/pinboard/liveboard123');
    });

    it('should filter out answers without TML', async () => {
      const answers = [
        {
          question: 'Question 1',
          tml: { answer: { name: 'Answer 1' } }
        },
        {
          question: 'Question 2',
          tml: null
        },
        {
          question: 'Question 3',
          tml: { answer: { name: 'Answer 3' } }
        }
      ];

      mockClient.importMetadataTML = vi.fn().mockResolvedValue([
        { response: { header: { id_guid: 'liveboard123' } } }
      ]);

      await createLiveboard('Test Liveboard', answers, mockClient);

      const tmlCall = (mockClient.importMetadataTML as any).mock.calls[0][0];
      const tmlData = JSON.parse(tmlCall.metadata_tmls[0]);
      
      expect(tmlData.liveboard.visualizations).toHaveLength(2);
      expect(tmlData.liveboard.layout.tiles).toHaveLength(2);
    });

    it('should handle import errors', async () => {
      const answers = [
        {
          question: 'Question 1',
          tml: { answer: { name: 'Answer 1' } }
        }
      ];

      mockClient.importMetadataTML = vi.fn().mockRejectedValue(new Error('Import Error'));

      await expect(createLiveboard('Test Liveboard', answers, mockClient))
        .rejects.toThrow('Import Error');
    });
  });

  describe('getDataSources', () => {
    it('should return data sources successfully', async () => {
      const mockResponse = [
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Sales Data',
            id: 'ws1',
            description: 'Sales information'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Revenue Data',
            id: 'ws2',
            description: 'Revenue information'
          }
        },
        {
          metadata_header: {
            type: 'LOGICAL_TABLE', // This should be filtered out
            name: 'Other Data',
            id: 'lt1',
            description: 'Other information'
          }
        }
      ];

      mockClient.searchMetadata = vi.fn().mockResolvedValue(mockResponse);

      const result = await getDataSources(mockClient);

      expect(mockClient.searchMetadata).toHaveBeenCalledWith({
        metadata: [{ type: 'LOGICAL_TABLE' }],
        record_size: 2000,
        sort_options: {
          field_name: 'LAST_ACCESSED',
          order: 'DESC',
        }
      });

      expect(result).toEqual([
        {
          name: 'Sales Data',
          id: 'ws1',
          description: 'Sales information'
        },
        {
          name: 'Revenue Data',
          id: 'ws2',
          description: 'Revenue information'
        }
      ]);
    });

    it('should handle empty response', async () => {
      mockClient.searchMetadata = vi.fn().mockResolvedValue([]);

      const result = await getDataSources(mockClient);

      expect(result).toEqual([]);
    });

    it('should handle API errors', async () => {
      const error = new Error('API Error');
      mockClient.searchMetadata = vi.fn().mockRejectedValue(error);

      await expect(getDataSources(mockClient)).rejects.toThrow('API Error');
    });
  });

  describe('getSessionInfo', () => {
    it('should return session info with production mixpanel token', async () => {
      const mockResponse = {
        configInfo: {
          mixpanelConfig: {
            production: true,
            devSdkKey: 'dev-key',
            prodSdkKey: 'prod-key'
          },
          selfClusterName: 'test-cluster',
          selfClusterId: 'cluster-123'
        },
        userGUID: 'user-123',
        userName: 'testuser',
        releaseVersion: '8.0.0',
        currentOrgId: 'org-123',
        privileges: ['READ', 'WRITE']
      };

      (mockClient as any).getSessionInfo = vi.fn().mockResolvedValue(mockResponse);

      const result = await getSessionInfo(mockClient);

      expect((mockClient as any).getSessionInfo).toHaveBeenCalled();

      expect(result).toEqual({
        mixpanelToken: 'prod-key',
        userGUID: 'user-123',
        userName: 'testuser',
        clusterName: 'test-cluster',
        clusterId: 'cluster-123',
        releaseVersion: '8.0.0',
        currentOrgId: 'org-123',
        privileges: ['READ', 'WRITE']
      });
    });

    it('should return session info with development mixpanel token', async () => {
      const mockResponse = {
        configInfo: {
          mixpanelConfig: {
            production: false,
            devSdkKey: 'dev-key',
            prodSdkKey: 'prod-key'
          },
          selfClusterName: 'test-cluster',
          selfClusterId: 'cluster-123'
        },
        userGUID: 'user-123',
        userName: 'testuser',
        releaseVersion: '8.0.0',
        currentOrgId: 'org-123',
        privileges: ['READ']
      };

      (mockClient as any).getSessionInfo = vi.fn().mockResolvedValue(mockResponse);

      const result = await getSessionInfo(mockClient);

      expect(result.mixpanelToken).toBe('dev-key');
    });

    it('should handle API errors', async () => {
      const error = new Error('API Error');
      (mockClient as any).getSessionInfo = vi.fn().mockRejectedValue(error);

      await expect(getSessionInfo(mockClient)).rejects.toThrow('API Error');
    });
  });
}); 
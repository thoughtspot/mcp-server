import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ThoughtSpotRestApi } from '@thoughtspot/rest-api-sdk';
import {
  getRelevantQuestions,
  getAnswerForQuestion,
  fetchTMLAndCreateLiveboard,
  createLiveboard,
  getDataSources,
  getSessionInfo,
  ThoughtSpotService,
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

      const result = await fetchTMLAndCreateLiveboard('Test Liveboard', answers, 'Test summary', mockClient);

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

      const result = await fetchTMLAndCreateLiveboard('Test Liveboard', answers, 'Test summary', mockClient);

      expect(result).toEqual({
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
          id: 'Viz_1',
          question: 'Question 1',
          answer: { name: 'Answer 1' }
        },
        {
          id: 'Viz_2',
          question: 'Question 2',
          answer: { name: 'Answer 2' }
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

  describe('searchWorksheets', () => {
    it('should search and return matching worksheets successfully', async () => {
      const mockResponse = [
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Sales Data Analytics',
            id: 'ws1',
            description: 'Sales analytics worksheet'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Revenue Analysis',
            id: 'ws2',
            description: 'Revenue analysis worksheet'
          }
        },
        {
          metadata_header: {
            type: 'LOGICAL_TABLE', // This should be filtered out
            name: 'Sales Data Table',
            id: 'lt1',
            description: 'Sales data table'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Customer Data',
            id: 'ws3',
            description: 'Customer information worksheet'
          }
        }
      ];

      mockClient.searchMetadata = vi.fn().mockResolvedValue(mockResponse);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.searchWorksheets('sales');

      expect(mockClient.searchMetadata).toHaveBeenCalledWith({
        metadata: [{ type: 'LOGICAL_TABLE' }],
        record_size: 100,
        sort_options: {
          field_name: 'NAME',
          order: 'ASC',
        }
      });

      expect(result).toEqual([
        {
          name: 'Sales Data Analytics',
          id: 'ws1',
          description: 'Sales analytics worksheet'
        }
      ]);
    });

    it('should perform case-insensitive search', async () => {
      const mockResponse = [
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Sales Data Analytics',
            id: 'ws1',
            description: 'Sales analytics worksheet'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'REVENUE Analysis',
            id: 'ws2',
            description: 'Revenue analysis worksheet'
          }
        }
      ];

      mockClient.searchMetadata = vi.fn().mockResolvedValue(mockResponse);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.searchWorksheets('SALES');

      expect(result).toEqual([
        {
          name: 'Sales Data Analytics',
          id: 'ws1',
          description: 'Sales analytics worksheet'
        }
      ]);
    });

    it('should return empty array when no worksheets match search term', async () => {
      const mockResponse = [
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Customer Data',
            id: 'ws1',
            description: 'Customer information worksheet'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Product Catalog',
            id: 'ws2',
            description: 'Product catalog worksheet'
          }
        }
      ];

      mockClient.searchMetadata = vi.fn().mockResolvedValue(mockResponse);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.searchWorksheets('nonexistent');

      expect(result).toEqual([]);
    });

    it('should handle empty search term', async () => {
      const mockResponse = [
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Sales Data',
            id: 'ws1',
            description: 'Sales worksheet'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Revenue Data',
            id: 'ws2',
            description: 'Revenue worksheet'
          }
        }
      ];

      mockClient.searchMetadata = vi.fn().mockResolvedValue(mockResponse);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.searchWorksheets('');

      // Empty string should match all worksheets
      expect(result).toEqual([
        {
          name: 'Sales Data',
          id: 'ws1',
          description: 'Sales worksheet'
        },
        {
          name: 'Revenue Data',
          id: 'ws2',
          description: 'Revenue worksheet'
        }
      ]);
    });

    it('should filter out non-worksheet metadata types', async () => {
      const mockResponse = [
        {
          metadata_header: {
            type: 'LOGICAL_TABLE',
            name: 'Sales Table',
            id: 'lt1',
            description: 'Sales table'
          }
        },
        {
          metadata_header: {
            type: 'LIVEBOARD',
            name: 'Sales Dashboard',
            id: 'lb1',
            description: 'Sales dashboard'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Sales Data',
            id: 'ws1',
            description: 'Sales worksheet'
          }
        }
      ];

      mockClient.searchMetadata = vi.fn().mockResolvedValue(mockResponse);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.searchWorksheets('sales');

      expect(result).toEqual([
        {
          name: 'Sales Data',
          id: 'ws1',
          description: 'Sales worksheet'
        }
      ]);
    });

    it('should handle API errors', async () => {
      const error = new Error('Search API Error');
      mockClient.searchMetadata = vi.fn().mockRejectedValue(error);

      const service = new ThoughtSpotService(mockClient);

      await expect(service.searchWorksheets('sales')).rejects.toThrow('Search API Error');
    });

    it('should handle empty API response', async () => {
      mockClient.searchMetadata = vi.fn().mockResolvedValue([]);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.searchWorksheets('sales');

      expect(result).toEqual([]);
    });

    it('should handle partial matches in worksheet names', async () => {
      const mockResponse = [
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Q1 Sales Performance',
            id: 'ws1',
            description: 'Q1 sales performance worksheet'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Annual Sales Report',
            id: 'ws2',
            description: 'Annual sales report worksheet'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Customer Data',
            id: 'ws3',
            description: 'Customer information worksheet'
          }
        }
      ];

      mockClient.searchMetadata = vi.fn().mockResolvedValue(mockResponse);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.searchWorksheets('sales');

      expect(result).toEqual([
        {
          name: 'Q1 Sales Performance',
          id: 'ws1',
          description: 'Q1 sales performance worksheet'
        },
        {
          name: 'Annual Sales Report',
          id: 'ws2',
          description: 'Annual sales report worksheet'
        }
      ]);
    });

    it('should handle search with special characters', async () => {
      const mockResponse = [
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Sales & Marketing Data',
            id: 'ws1',
            description: 'Sales and marketing worksheet'
          }
        },
        {
          metadata_header: {
            type: 'WORKSHEET',
            name: 'Revenue Analysis',
            id: 'ws2',
            description: 'Revenue analysis worksheet'
          }
        }
      ];

      mockClient.searchMetadata = vi.fn().mockResolvedValue(mockResponse);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.searchWorksheets('&');

      expect(result).toEqual([
        {
          name: 'Sales & Marketing Data',
          id: 'ws1',
          description: 'Sales and marketing worksheet'
        }
      ]);
    });
  });

  describe('getAnswerImagePNG', () => {
    it('should return PNG image data successfully', async () => {
      const sessionId = 'session123';
      const genNo = 1;
      const mockImageFile = {
        blob: vi.fn().mockResolvedValue(new Blob(['mock image data'], { type: 'image/png' })),
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        text: vi.fn().mockResolvedValue('mock image text')
      };

      mockClient.exportAnswerReport = vi.fn().mockResolvedValue(mockImageFile);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.getAnswerImagePNG(sessionId, genNo);

      expect(mockClient.exportAnswerReport).toHaveBeenCalledWith({
        session_identifier: sessionId,
        generation_number: genNo,
        file_format: 'PNG',
      });

      expect(result).toBe(mockImageFile);
    });

    it('should handle API errors when exporting PNG', async () => {
      const sessionId = 'session456';
      const genNo = 2;
      const error = new Error('PNG Export Error');

      mockClient.exportAnswerReport = vi.fn().mockRejectedValue(error);

      const service = new ThoughtSpotService(mockClient);

      await expect(service.getAnswerImagePNG(sessionId, genNo))
        .rejects.toThrow('PNG Export Error');

      expect(mockClient.exportAnswerReport).toHaveBeenCalledWith({
        session_identifier: sessionId,
        generation_number: genNo,
        file_format: 'PNG',
      });
    });

    it('should handle different session identifiers and generation numbers', async () => {
      const testCases = [
        { sessionId: 'session-abc-123', genNo: 0 },
        { sessionId: 'session-def-456', genNo: 5 },
        { sessionId: 'session-xyz-789', genNo: 100 }
      ];

      const mockImageFile = {
        blob: vi.fn().mockResolvedValue(new Blob(['mock image data'], { type: 'image/png' }))
      };

      for (const { sessionId, genNo } of testCases) {
        mockClient.exportAnswerReport = vi.fn().mockResolvedValue(mockImageFile);

        const service = new ThoughtSpotService(mockClient);
        const result = await service.getAnswerImagePNG(sessionId, genNo);

        expect(mockClient.exportAnswerReport).toHaveBeenCalledWith({
          session_identifier: sessionId,
          generation_number: genNo,
          file_format: 'PNG',
        });

        expect(result).toBe(mockImageFile);
      }
    });

    it('should handle empty session identifier', async () => {
      const sessionId = '';
      const genNo = 1;
      const mockImageFile = {
        blob: vi.fn().mockResolvedValue(new Blob(['mock image data'], { type: 'image/png' }))
      };

      mockClient.exportAnswerReport = vi.fn().mockResolvedValue(mockImageFile);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.getAnswerImagePNG(sessionId, genNo);

      expect(mockClient.exportAnswerReport).toHaveBeenCalledWith({
        session_identifier: '',
        generation_number: genNo,
        file_format: 'PNG',
      });

      expect(result).toBe(mockImageFile);
    });

    it('should handle negative generation numbers', async () => {
      const sessionId = 'session123';
      const genNo = -1;
      const mockImageFile = {
        blob: vi.fn().mockResolvedValue(new Blob(['mock image data'], { type: 'image/png' }))
      };

      mockClient.exportAnswerReport = vi.fn().mockResolvedValue(mockImageFile);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.getAnswerImagePNG(sessionId, genNo);

      expect(mockClient.exportAnswerReport).toHaveBeenCalledWith({
        session_identifier: sessionId,
        generation_number: genNo,
        file_format: 'PNG',
      });

      expect(result).toBe(mockImageFile);
    });

    it('should handle network timeout errors', async () => {
      const sessionId = 'session123';
      const genNo = 1;
      const timeoutError = new Error('Network timeout');
      timeoutError.name = 'TimeoutError';

      mockClient.exportAnswerReport = vi.fn().mockRejectedValue(timeoutError);

      const service = new ThoughtSpotService(mockClient);

      await expect(service.getAnswerImagePNG(sessionId, genNo))
        .rejects.toThrow('Network timeout');

      expect(mockClient.exportAnswerReport).toHaveBeenCalledWith({
        session_identifier: sessionId,
        generation_number: genNo,
        file_format: 'PNG',
      });
    });

    it('should handle authentication errors', async () => {
      const sessionId = 'session123';
      const genNo = 1;
      const authError = new Error('Authentication failed');
      authError.name = 'AuthenticationError';

      mockClient.exportAnswerReport = vi.fn().mockRejectedValue(authError);

      const service = new ThoughtSpotService(mockClient);

      await expect(service.getAnswerImagePNG(sessionId, genNo))
        .rejects.toThrow('Authentication failed');
    });

    it('should return the exact file object from the API', async () => {
      const sessionId = 'session123';
      const genNo = 1;
      const mockImageFile = {
        name: 'answer-image.png',
        size: 1024,
        type: 'image/png',
        lastModified: Date.now(),
        blob: vi.fn().mockResolvedValue(new Blob(['mock image data'], { type: 'image/png' })),
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1024)),
        text: vi.fn().mockResolvedValue('mock image text'),
        stream: vi.fn()
      };

      mockClient.exportAnswerReport = vi.fn().mockResolvedValue(mockImageFile);

      const service = new ThoughtSpotService(mockClient);
      const result = await service.getAnswerImagePNG(sessionId, genNo);

      // Verify that the exact object is returned without modification
      expect(result).toBe(mockImageFile);
      expect(result).toHaveProperty('name', 'answer-image.png');
      expect(result).toHaveProperty('size', 1024);
      expect(result).toHaveProperty('type', 'image/png');
    });
  });
}); 
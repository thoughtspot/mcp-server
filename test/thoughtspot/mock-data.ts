// Mock data for ThoughtSpot client tests

export const mockSessionData = {
  session_identifier: 'test-session-123',
  generation_number: 1
};

export const mockTMLResponse = {
  data: {
    UnsavedAnswer_getTML: {
      zipFile: null,
      object: [{
        edoc: `
guid: "test-guid-123"
type: "ANSWER"
name: "Test Answer"
description: "A test answer for unit testing"
content: |
  This is a test TML content
  with multiple lines
  for testing purposes
        `,
        name: "Test Answer",
        type: "ANSWER",
        __typename: "Answer"
      }],
      __typename: "UnsavedAnswerTMLResponse"
    }
  }
};

export const mockParsedTML = {
  guid: "test-guid-123",
  type: "ANSWER",
  name: "Test Answer",
  description: "A test answer for unit testing",
  content: "This is a test TML content\nwith multiple lines\nfor testing purposes"
};

export const mockSessionInfo = {
  userId: "user-123",
  userName: "test-user",
  email: "test@example.com",
  displayName: "Test User",
  tenantId: "tenant-123",
  locale: "en-US",
  timezone: "UTC"
};

export const mockErrorResponse = {
  errors: [
    {
      message: "Invalid session identifier",
      code: "INVALID_SESSION",
      path: ["UnsavedAnswer_getTML"]
    }
  ]
};

export const mockNetworkError = new Error('Network error: Failed to fetch');

export const mockInvalidResponse = {
  data: {
    UnsavedAnswer_getTML: {
      object: [] // Empty array to simulate no data
    }
  }
};

export const mockMalformedResponse = {
  // Missing expected structure
  someOtherProperty: "value"
};

// Test configuration
export const testConfig = {
  instanceUrl: 'https://test.thoughtspot.com',
  bearerToken: 'test-token-123',
  proxyUrl: 'https://plugin-party-vercel.vercel.app/api/proxy',
  timeout: 30000
};

// GraphQL query for testing
export const expectedGraphQLQuery = `
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

// Expected request payload for testing
export const expectedRequestPayload = {
  token: testConfig.bearerToken,
  clusterUrl: testConfig.instanceUrl,
  endpoint: '/prism/?op=GetUnsavedAnswerTML',
  payload: {
    operationName: 'GetUnsavedAnswerTML',
    query: expectedGraphQLQuery.trim(),
    variables: {
      session: {
        sessionId: mockSessionData.session_identifier,
        genNo: mockSessionData.generation_number,
      }
    }
  }
};

// Expected headers for testing
export const expectedHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

export const expectedSessionInfoHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'user-agent': 'ThoughtSpot-ts-client',
  'Authorization': `Bearer ${testConfig.bearerToken}`,
}; 
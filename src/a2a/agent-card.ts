import type { AgentCard } from "@a2a-js/sdk";


// Public agent card (for discovery)
export const thoughtSpotAgentCard: AgentCard = {
  name: "ThoughtSpot Agent",
  description:
    "An agent that can answer users data queries from ThoughtSpot.",
  url: "http://myserver.com:8787/a2a",
  provider: {
    organization: "ThoughtSpot",
    url: "https://www.thoughtspot.com",
  },
  version: "0.0.2",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  // Basic security info without sensitive details
  securitySchemes: {
    thoughtspot_oauth: {
      description: "OAuth2.0 security scheme configuration. Use this to authenticate with the agent.",
      type: "oauth2",
      flows: {
        authorizationCode: {
          authorizationUrl: "http://myserver.com:8787/authorize",
          tokenUrl: "http://myserver.com:8787/token",
          scopes: {}
        }
      }
    }
  },
  security: [{ thoughtspot_oauth: [] }],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  // Basic skills without detailed examples
  skills: [
    {
      id: "ping",
      name: "Ping",
      description: "Test connectivity and authentication status.",
      tags: ["test", "authentication"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    },
    {
      id: "get-relevant-questions",
      name: "Get Relevant Questions",
      description: "Get relevant questions given a user's query. Whenever the user asks a question, you should use this skill to get the relevant questions related to the user's query. This skill requires the user's query and the datasource id as input.",
      tags: ["questions", "relevant"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    },
    {
      id: "get-answer-from-thoughtspot",
      name: "Get Answer From ThoughtSpot",
      description: "Get an answer from ThoughtSpot given a user's query and the datasource id as input. This skill requires the user's query and the datasource id as input.",
      tags: ["questions", "answer"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    }
  ],
  supportsAuthenticatedExtendedCard: true,
};
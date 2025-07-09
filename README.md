<p align="center">
    <img src="https://raw.githubusercontent.com/thoughtspot/visual-embed-sdk/main/static/doc-images/images/TS-Logo-black-no-bg.svg" width=120 align="center" alt="ThoughtSpot" />
</p>

<br/>

# ThoughtSpot MCP Server <br/> ![MCP Server](https://badge.mcpx.dev?type=server 'MCP Server') ![Static Badge](https://img.shields.io/badge/cloudflare%20worker-deployed-green?link=https%3A%2F%2Fdash.cloudflare.com%2F485d90aa3d1ea138ad7ede769fe2c35e%2Fworkers%2Fservices%2Fview%2Fthoughtspot-mcp-server%2Fproduction%2Fmetrics) ![GitHub branch check runs](https://img.shields.io/github/check-runs/thoughtspot/mcp-server/main) [![Coverage Status](https://coveralls.io/repos/github/thoughtspot/mcp-server/badge.svg?branch=main)](https://coveralls.io/github/thoughtspot/mcp-server?branch=main) <a href="https://developer.thoughtspot.com/join-discord" target="_blank"> <img alt="Discord: ThoughtSpot" src="https://img.shields.io/discord/1143209406037758065?style=flat-square&label=Chat%20on%20Discord" /> </a>


The ThoughtSpot MCP Server provides secure OAuth-based authentication and a set of tools for querying and retrieving relevant data from your ThoughtSpot instance. It's a remote server hosted on Cloudflare.

If you do not have a Thoughtspot account, create one for free [here](https://thoughtspot.com/trial).

Learn more about [ThoughtSpot](https://thoughtspot.com).

Join our [Discord](https://developers.thoughtspot.com/join-discord) to get support.

## Table of Contents

- [Usage](#mcp-client-configuration)
- [Demo video](#demo)
- [Usage in APIs](#usage-in-apis)
  - [OpenAI / ChatGPT](#openai-responses-api)
  - [Claude](#claude-mcp-connector)
- [Features](#features)
  - [Supported transports](#supported-transports)
- [Stdio support (fallback)](#stdio-support-fallback)
  - [How to obtain a TS_AUTH_TOKEN](#how-to-obtain-a-ts_auth_token)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
  - [Local Development](#local-development)
  - [Endpoints](#endpoints)


## Usage

To configure this MCP server in your MCP client (such as Claude Desktop, Windsurf, Cursor, etc.), add the following configuration to your MCP client settings:

```json
{
  "mcpServers": {
    "ThoughtSpot": {
      "command": "npx",
      "args": [
         "mcp-remote",
         "https://agent.thoughtspot.app/sse"
      ]
    }
  }
}
```

See the [Troubleshooting](#troubleshooting) section for any errors.

## Demo

Here is a demo video using Claude Desktop.

https://github.com/user-attachments/assets/72a5383a-7b2a-4987-857a-b6218d7eea22

Watch on [Loom](https://www.loom.com/share/433988d98a7b41fb8df2239da014169a?sid=ef2032a2-6e9b-4902-bef0-57df5623963e)

## Usage in APIs

ThoughtSpot's remote MCP server can be used in LLM APIs which support calling MCP tools. 

Here are examples with the common LLM providers:

### OpenAI Responses API

```bash
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
  "model": "gpt-4.1",
  "tools": [
    {
      "type": "mcp",
      "server_label": "thoughtspot",
      "server_url": "https://agent.thoughtspot.app/bearer/mcp",
      "headers": {
        "Authorization": "Bearer $TS_AUTH_TOKEN",
        "x-ts-host": "my-thoughtspot-instance.thoughtspot.cloud"
      }
    }
  ],
  "input": "How can I increase my sales ?"
}'
```

More details on how can you use OpenAI API with MCP tool calling can be found [here](https://platform.openai.com/docs/guides/tools-remote-mcp).


### Claude MCP Connector

```bash
curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: mcp-client-2025-04-04" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1000,
    "messages": [{
      "role": "user", 
      "content": "How do I increase my sales ?"
    }],
    "mcp_servers": [
      {
        "type": "url",
        "url": "https://agent.thoughtspot.app/bearer/mcp",
        "name": "thoughtspot",
        "authorization_token": "$TS_AUTH_TOKEN@my-thoughtspot-instance.thoughtspot.cloud"
      }
    ]
  }'
```

Note: In the `authorization_token` field we have suffixed the ThoughtSpot instance host as well with the `@` symbol to the `TS_AUTH_TOKEN`.

More details on Claude MCP connector [here](https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector).

### How to get TS_AUTH_TOKEN for APIs ?

For API usage, you would the token endpoints with a `secret_key` to generate the `API_TOKEN` for a specific user/role, more details [here](https://developers.thoughtspot.com/docs/api-authv2#trusted-auth-v2). 


## Features

- **OAuth Authentication**: Access your data, as yourself.
- **Tools**:
  - `ping`: Test connectivity and authentication.
  - `getRelevantQuestions`: Get relevant data questions from ThoughtSpot analytics based on a user query.
  - `getAnswer`: Get the answer to a specific question from ThoughtSpot analytics.
  - `createLiveboard`: Create a liveboard from a list of answers.
- **MCP Resources**:
   - `datasources`: List of ThoughtSpot Data models the user has access to.

### Supported transports

- SSE [/sse]()
- Streamed HTTP [/mcp]()

## Stdio support (fallback)

If you are unable to use the remote MCP server due to connectivity restrictions on your Thoughtspot instance. You could use the `stdio` local transport using the `npm` package.

Here is how to configure `stdio` with MCP Client:

```json 
{
  "mcpServers": {
    "ThoughtSpot": {
      "command": "npx",
      "args": [
         "@thoughtspot/mcp-server"
      ],
      "env": {
         "TS_INSTANCE": "<your Thoughtspot Instance URL>",
         "TS_AUTH_TOKEN": "<ThoughtSpot Access Token>"
      }
    }
  }
}
```

### How to obtain a `TS_AUTH_TOKEN` ?

- Go to ThoughtSpot => _Develop_ => _Rest Playground v2.0_
- _Authentication_ => _Get Full access token_
- Scroll down and expand the "body"
- Add your "username" and "password".
- Put whatever "validity_time" you want the token to be.
- Click on "Try it out" on the bottom right.
- You should get a token in the response, thats the bearer token.

#### Alternative way to get `TS_AUTH_TOKEN`
- Login to the ThoughtSpot instance as you would normally.
- Opem in a new tab this URL:
  - https://your-ts-instance/api/rest/2.0/auth/session/token
- You will see a JSON response, copy the "token" value (without the quotes).
- This is the token you could use.

### Troubleshooting

> Oauth errors due to CORS/SAML.

Make sure to add the following entries in your ThoughtSpot instance:

*CORS*

- Go to ThoughtSpot => _Develop_ => Security settings
- Click "Edit"
- Add "agent.thoughtspot.app" to the the "CORS whitelisted domains". 

*SAML* (need to be Admin)

- Go to ThoughtSpot => _Develop_
- Go to "All Orgs" Tab on the left panel if there is one.
- Click "Security settings"
- Click "Edit"
- Add "agent.thoughtspot.app" to the the "SAML redirect domains". 

## Contributing

### Local Development

1. **Install dependencies**:
   ```sh
   npm install
   ```
2. **Set up environment variables**:
   - Copy `.dev.vars` and fill in your ThoughtSpot instance URL and access token.
3. **Start the development server**:
   ```sh
   npm run dev
   ```

### Endpoints

- `/mcp`: MCP HTTP Streaming endpoint
- `/sse`: Server-sent events for MCP
- `/api`: MCP tools exposed as HTTP endpoints
- `/authorize`, `/token`, `/register`: OAuth endpoints
- `/bearer/mcp`, `/bearer/sse`: MCP endpoints as bearer auth instead of Oauth, mainly for use in APIs or in cases where Oauth is not working.

MCP Server, © ThoughtSpot, Inc. 2025

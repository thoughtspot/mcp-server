<p align="center">
    <img src="https://raw.githubusercontent.com/thoughtspot/visual-embed-sdk/main/static/doc-images/images/TS-Logo-black-no-bg.svg" width=120 align="center" alt="ThoughtSpot" />
</p>

<br/>

# ThoughtSpot MCP Server <br/> ![MCP Server](https://badge.mcpx.dev?type=server 'MCP Server') ![Static Badge](https://img.shields.io/badge/cloudflare%20worker-deployed-green?link=https%3A%2F%2Fdash.cloudflare.com%2F485d90aa3d1ea138ad7ede769fe2c35e%2Fworkers%2Fservices%2Fview%2Fthoughtspot-mcp-server%2Fproduction%2Fmetrics) ![GitHub branch check runs](https://img.shields.io/github/check-runs/thoughtspot/mcp-server/main) [![Coverage Status](https://coveralls.io/repos/github/thoughtspot/mcp-server/badge.svg?branch=main)](https://coveralls.io/github/thoughtspot/mcp-server?branch=main)


The ThoughtSpot MCP Server provides secure OAuth-based authentication and a set of tools for querying and retrieving relevant data from your ThoughtSpot instance. It's a remote server hosted on Cloudflare.

If you do not have a Thoughtspot account, create one for free [here](https://thoughtspot.com/trial).

Learn more about [ThoughtSpot](https://thoughtspot.com).

Join our [Discord](https://developers.thoughtspot.com/join-discord) to get support.

## Table of Contents

- [MCP Client Configuration](#mcp-client-configuration)
- [Features](#features)
  - [Supported transports](#supported-transports)
- [Contributing](#contributing)
  - [Local Development](#local-development)
  - [Endpoints](#endpoints)
- [Configuration](#configuration)
- [Stdio support (fallback)](#stdio-support-fallback)
  - [How to obtain a TS_AUTH_TOKEN](#how-to-obtain-a-ts_auth_token)

## MCP Client Configuration

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

## Configuration

- **wrangler.jsonc**: Configure bindings, secrets, and compatibility.


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

#### How to obtain a `TS_AUTH_TOKEN` ?

- Go to ThoughtSpot => _Develop_ => _Rest Playground v2.0_
- _Authentication_ => _Get Full access token_
- Scroll down and expand the "body"
- Add your "username" and "password".
- Put whatever "validity_time" you want the token to be.
- Click on "Try it out" on the bottom right.
- You should get a token in the response, thats the bearer token.


MCP Server, © ThoughtSpot, Inc. 2025


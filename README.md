<p align="center">
    <img src="https://raw.githubusercontent.com/thoughtspot/visual-embed-sdk/main/static/doc-images/images/TS-Logo-black-no-bg.svg" width=120 align="center" alt="ThoughtSpot" />
</p>

<br/>

# ThoughtSpot MCP Server <br/> ![Static Badge](https://img.shields.io/badge/cloudflare%20worker-deployed-green?link=https%3A%2F%2Fdash.cloudflare.com%2F485d90aa3d1ea138ad7ede769fe2c35e%2Fworkers%2Fservices%2Fview%2Fthoughtspot-mcp-server%2Fproduction%2Fmetrics) ![GitHub branch check runs](https://img.shields.io/github/check-runs/thoughtspot/mcp-server/main) [![Coverage Status](https://coveralls.io/repos/github/thoughtspot/mcp-server/badge.svg?branch=main)](https://coveralls.io/github/thoughtspot/mcp-server?branch=main)



The ThoughtSpot MCP Server is a Cloudflare Worker-based service that exposes Model Context Protocol (MCP) endpoints for interacting with ThoughtSpot data and tools. It provides secure OAuth-based authentication and a set of tools for querying and retrieving relevant data from a ThoughtSpot instance.

## Table of Contents

- [Features](#features)
- [Project Structure](#project-structure)
- [Scripts](#scripts)
- [Usage](#usage)
- [Endpoints](#endpoints)
- [Configuration](#configuration)
- [License](#license)

## Features

- **OAuth Authentication**: Secure endpoints using OAuth flows.
- **MCP Tools**:
  - `ping`: Test connectivity and authentication.
  - `getRelevantData`: Query ThoughtSpot for relevant data based on a user question, returning answers and optionally a dashboard (Liveboard) link.

## Project Structure

```
.
├── src/
│   ├── index.ts                # Main entry point, sets up OAuth and MCP endpoints
│   ├── handlers.ts             # HTTP route handlers (OAuth, root, etc.)
│   ├── utils.ts                # Shared types/utilities
│   └── thoughtspot/
│       ├── relevant-data.ts    # Logic for fetching relevant data/answers
│       ├── thoughtspot-client.ts # Client setup for ThoughtSpot API
│       └── thoughtspot-service.ts # Service functions for questions, answers, liveboards
├── static/                     # Static assets (if any)
├── wrangler.jsonc              # Cloudflare Worker configuration
├── package.json                # Project metadata and scripts
└── README.md                   # This file
```

## Scripts

- `start` / `dev`: Start the worker locally with Wrangler.
- `deploy`: Deploy the worker to Cloudflare.
- `cf-typegen`: Generate Cloudflare Worker types.
- `format`: Format code using [biome](https://biomejs.dev/).
- `lint:fix`: Lint and auto-fix code using biome.

## Usage

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

### Deployment

Deploy to Cloudflare Workers using Wrangler:
```sh
npm run deploy
```

### Endpoints

- `/mcp`: MCP HTTP Streaming endpoint
- `/sse`: Server-sent events for MCP
- `/authorize`, `/token`, `/register`: OAuth endpoints

## Configuration

- **wrangler.jsonc**: Configure bindings, secrets, and compatibility.
- **Secrets**: Store your secrets securely using Cloudflare secrets.


MCP Server, © ThoughtSpot, Inc. 2025


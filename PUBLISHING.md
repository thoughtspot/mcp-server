# Publishing to MCP Registry

This document explains how to publish the ThoughtSpot MCP Server to the Model Context Protocol (MCP) Registry.

## Automated Publishing

The server is automatically published to the MCP Registry when:

1. **Git Tags**: Push a version tag (e.g., `v1.0.0`)
2. **GitHub Releases**: Create a new release on GitHub

### Workflows

- `.github/workflows/publish-mcp.yml` - Triggers on version tags
- `.github/workflows/release.yml` - Triggers on GitHub releases

Both workflows will:
1. Run tests and linting
2. Publish to npm (requires `NPM_TOKEN` secret)
3. Validate `server.json` against the MCP schema
4. Publish to the MCP Registry

## Manual Publishing

### Prerequisites

1. Install the MCP Publisher CLI:
   ```bash
   brew install mcp-publisher
   ```

2. Install JSON schema validator (optional but recommended):
   ```bash
   npm install -g ajv-cli
   ```

### Steps

1. **Validate the server configuration**:
   ```bash
   ./scripts/publish-mcp.sh
   ```

2. **Or manually**:
   ```bash
   # Validate server.json
   ajv validate -s server.schema.json -d server.json --strict=false
   
   # Login to MCP Registry
   mcp-publisher login github
   
   # Publish
   mcp-publisher publish
   ```

## Configuration

The server configuration is defined in `server.json`:

- **Name**: `io.github.thoughtspot/mcp-server`
- **Description**: MCP Server for ThoughtSpot - provides OAuth authentication and tools for querying data
- **Version**: Must match the version in `package.json`
- **Package**: Published to npm as `@thoughtspot/mcp-server`
- **Transport**: stdio (for local usage)

## Environment Variables

The server requires these environment variables:

- `TS_INSTANCE`: Your ThoughtSpot instance URL
- `TS_AUTH_TOKEN`: Your ThoughtSpot access token

## Registry URL

Once published, your server will be available at:
https://registry.modelcontextprotocol.io/servers/io.github.thoughtspot/mcp-server

## Troubleshooting

### Authentication Issues

If you encounter authentication issues:

1. Check if you're logged in: `mcp-publisher login --check`
2. Re-authenticate: `mcp-publisher login github`
3. Clear saved auth: `mcp-publisher logout`

### Validation Errors

If `server.json` validation fails:

1. Check the error message for specific issues
2. Ensure the description is under 100 characters
3. Verify all required fields are present
4. Check that the version matches `package.json`

### Publishing Errors

Common issues:

1. **Version mismatch**: Ensure `server.json` version matches `package.json`
2. **Missing NPM_TOKEN**: Required for automated publishing
3. **Invalid repository URL**: Must match your GitHub repository

## Updating the Server

To update the server:

1. Update the version in both `package.json` and `server.json`
2. Update the description or capabilities if needed
3. Create a new tag or release
4. The automated workflow will handle the rest

## Schema Validation

The `server.json` file is validated against the official MCP schema:
https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json

You can validate locally:
```bash
curl -o server.schema.json https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json
ajv validate -s server.schema.json -d server.json --strict=false
```

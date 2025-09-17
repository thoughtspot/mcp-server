#!/bin/bash

# Script to manually publish MCP server to registry
# Usage: ./scripts/publish-mcp.sh

set -e

echo "🚀 Publishing MCP Server to Registry..."

# Check if mcp-publisher is installed
if ! command -v mcp-publisher &> /dev/null; then
    echo "❌ mcp-publisher not found. Installing..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install mcp-publisher
    else
        echo "Please install mcp-publisher manually: https://github.com/modelcontextprotocol/registry"
        exit 1
    fi
fi

# Validate server.json
echo "📋 Validating server.json..."
if command -v ajv &> /dev/null; then
    # Download schema if not exists
    if [ ! -f "server.schema.json" ]; then
        curl -o server.schema.json https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json
    fi
    ajv validate -s server.schema.json -d server.json --strict=false
    echo "✅ server.json is valid"
else
    echo "⚠️  ajv not found, skipping validation. Install with: npm install -g ajv-cli"
fi

# Check if logged in
echo "🔐 Checking authentication..."
if ! mcp-publisher login --check 2>/dev/null; then
    echo "🔑 Please log in to MCP Registry:"
    mcp-publisher login dns --domain thoughtspot.app --private-key $(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')
fi

# Publish
echo "📤 Publishing to MCP Registry..."
mcp-publisher publish

echo "✅ Successfully published to MCP Registry!"
echo "🌐 Check your server at: https://registry.modelcontextprotocol.io/servers/io.github.thoughtspot/mcp-server"

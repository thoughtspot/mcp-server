# Self hosted ThoughtSpot MCP Server

This guide explains how to deploy and use the ThoughtSpot MCP Server using the published Docker image [ghcr.io/thoughtspot/thoughtspot-mcp-server:latest](https://github.com/thoughtspot/mcp-server/pkgs/container/thoughtspot-mcp-server).

## Quick Start

### 1. Pull the Docker Image

```bash
docker pull ghcr.io/thoughtspot/thoughtspot-mcp-server:latest
```

### 2. Run the Container

```bash
docker run -d \
  --name thoughtspot-mcp-server \
  -p 3000:3000 \
  -e THOUGHTSPOT_INSTANCE_URL="https://your-instance.thoughtspot.cloud" \
  ghcr.io/thoughtspot/thoughtspot-mcp-server:latest
```

### 3. Test the Server

Use the MCP inspector to connect to `http://localhost:3000`.

## Configuration

### Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `THOUGHTSPOT_INSTANCE_URL` | Your ThoughtSpot instance URL | Yes | `https://mycompany.thoughtspot.cloud` |
| `PORT` | Port to run the server on | No | `3000` (default) |

### Example with Custom Port

```bash
docker run -d \
  --name thoughtspot-mcp-server \
  -p 8080:8080 \
  -e THOUGHTSPOT_INSTANCE_URL="https://your-instance.thoughtspot.cloud" \
  -e PORT=8080 \
  ghcr.io/thoughtspot/thoughtspot-mcp-server:latest
```

## Monitoring and Logs

### View Container Logs

```bash
docker logs thoughtspot-mcp-server
```

### Follow Logs in Real-time

```bash
docker logs -f thoughtspot-mcp-server
```

### Health Check

The container includes a built-in health check. You can verify it's healthy:

```bash
docker ps
```

Look for `(healthy)` status in the container list.


## Usage without docker

```bash
git clone https://github.com/thoughtspot/mcp-server
npm i
```
Then run the application.

```bash
THOUGHTSPOT_INSTANCE_URL="<your thoughtspot instance>" npm run run:deploy
```

## Getting Help

- Join our [Discord](https://developers.thoughtspot.com/join-discord) for support
- Create an issue on the [GitHub repository](https://github.com/thoughtspot/mcp-server)
- Submit a [ThoughtSpot support case](https://community.thoughtspot.com/s/article/How-to-submit-a-ThoughtSpot-Support-Case)

## License

This MCP Server is licensed under the ThoughtSpot End User License Agreement.
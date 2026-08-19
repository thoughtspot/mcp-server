<p align="center">
    <img src="https://cdn.jsdelivr.net/gh/thoughtspot/visual-embed-sdk@main/static/doc-images/images/ThoughtSpot_appicon.png" width=120 align="center" alt="ThoughtSpot" />
</p>

<br/>

# ThoughtSpot MCP Server <br/> ![MCP Server](https://badge.mcpx.dev?type=server 'MCP Server') ![Static Badge](https://img.shields.io/badge/cloudflare%20worker-deployed-green?link=https%3A%2F%2Fdash.cloudflare.com%2F485d90aa3d1ea138ad7ede769fe2c35e%2Fworkers%2Fservices%2Fview%2Fthoughtspot-mcp-server%2Fproduction%2Fmetrics) ![GitHub branch check runs](https://img.shields.io/github/check-runs/thoughtspot/mcp-server/main) [![Coverage Status](https://coveralls.io/repos/github/thoughtspot/mcp-server/badge.svg?branch=main)](https://coveralls.io/github/thoughtspot/mcp-server?branch=main) <a href="https://developer.thoughtspot.com/join-discord" target="_blank"> <img alt="Discord: ThoughtSpot" src="https://img.shields.io/discord/1143209406037758065?style=flat-square&label=Chat%20on%20Discord" /> </a>


ThoughtSpot Spotter MCP Server provides a set of tools for querying and retrieving relevant data from your ThoughtSpot instance. Spotter connects to your ThoughtSpot instance, handles authentication securely, and returns live answers from your own data.

* [ThoughtSpot Spotter MCP Server documentation](https://developer-docs-git-mcp-server-updates-thoughtspot-site.vercel.app/docs/mcp-integration)
* [Create a free ThoughtSpot account](https://www.thoughtspot.com/trial?utm_source=mcp&utm_medium=consent&tsref=MCP)
* [What is ThoughtSpot?](https://thoughtspot.com/)
* [Get support on Discord](https://developers.thoughtspot.com/join-discord)
* [Privacy statement](https://www.thoughtspot.com/privacy-statement)

## Table of Contents

- [Manual client registration](#manual-client-registration)
  - [Associating with a ThoughtSpot instance](#associate-with-a-thoughtspot-instance)
- [Contributing](#contributing)
  - [Local Development](#local-development)


## Manual client registration

For MCP hosts which do not(yet) support Dynamic client registration, or they require statically adding Oauth Client Id etc. Go to [this](https://agent.thoughtspot.app/clients) page, to register a new client and copy the details over. The most relevant values are `Oauth Client Id` and `Oauth Client Secret` which should be added when adding ThoughtSpot as an MCP connector in the MCP client (ChatGPT/Claude etc). The generated client details are only available when they are generated and are NOT available later for reference.

### Associate with a ThoughtSpot instance

Manual client registration also allows to associate with a specific ThoughtSpot instance, so that your users do not have to enter the Thoughtspot instance URL when doing the authorization flow. While registering the Oauth client add `ThoughtSpot URL` to the appropriate value.


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

### Adding New Tools

When adding new MCP tools to the server:

1. **Define schemas and tools** in `src/servers/tool-definitions.ts`
2. **Implement handlers** in `src/servers/mcp-server.ts`
3. **Update version registry** in `src/servers/version-registry.ts`:
   - Add new tools to appropriate version(s) in `VERSION_REGISTRY`
   - For new stable features, update `DEFAULT_VERSION`
   - For beta features, add to the `beta` version entry
4. **Add tests** for new tools and version configurations
5. **Update documentation** in README.md

**Important:** The version registry controls which tools are available in each API version. Make sure to add new tools to the correct version configuration to ensure they're accessible to users.


MCP Server, © ThoughtSpot, Inc. 2026

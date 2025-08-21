- Glean actions

To configure the MCP server to be used via glean actions follow these steps:

1. Create a separate action for each the tools exposed through the MCP server
2. Add open api spec for the tool that you are adding in the functionality section. The openapi spec for each tool is available on this url : https://agent.thoughtspot.app/openapi-spec/tools/{tool_name}. Tool name here would be the name given in the tool set below in [Features](#features). For example, Get relevant data questions tool has name getRelevantQuestions. Note: getDataSourceSuggestions is not yet available as openapi-spec as the feature is not yet Generally Available in ThoughtSpot for all customers. We will add this once it is available.
3. Select authentication type as Oauth User while configuring the action
4. Register the glean oauth server with TS MCP server

```bash
 curl 'https://agent.thoughtspot.app/register' \
  -H 'accept: */*' \
  -H 'accept-language: en-US,en;q=0.9' \
  --data-raw '{"redirect_uris":["${glean_callback_url}"],"token_endpoint_auth_method":"client_secret_basic","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"{company_glean_name}","client_uri":"${company_glean_uri}"}'
```
5. Add the client_id and client secret obtained from to the glean action auth section. Along with this add https://agent.thoughtspot.app/authorize in client url and https://agent.thoughtspot.app/token in authorize url.
6. Save the spec and reload the action.
7. Once the action is saved, we will get an option to run API test. It is recommended to run it one time to make sure everything is setup.


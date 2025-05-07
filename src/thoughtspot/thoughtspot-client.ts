import { createBearerAuthenticationConfig, ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk"
import YAML from "yaml";

let token: string;

export const getThoughtSpotClient = (instanceUrl: string, bearerToken: string) => {
    const client = new ThoughtSpotRestApi(createBearerAuthenticationConfig(
        instanceUrl,
        () => Promise.resolve(bearerToken),
    ));
    (client as any).instanceUrl = instanceUrl;
    token = bearerToken;
    addExportUnsavedAnswerTML(client, instanceUrl);
    return client;
}

const getAnswerTML = `
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

// This is a workaround until we get the public API for this
function addExportUnsavedAnswerTML(client: any, instanceUrl: string) {
    (client as any).exportUnsavedAnswerTML = async ({ session_identifier, generation_number }) => {
        // make a graphql request to `ThoughtspotHost/prism endpoint.
        const response = await fetch(instanceUrl + "/prism/?op=GetUnsavedAnswerTML", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                "Accept": "application/json",
                "User-Agent": "ThoughtSpot-ts-client",
            },
            body: JSON.stringify({
                operationName: "GetUnsavedAnswerTML",
                query: getAnswerTML,
                variables: {
                    session: {
                        sessionId: session_identifier,
                        genNo: generation_number,
                    }
                }
            }),
        });

        const data = await response.json();
        const edoc = data.data.UnsavedAnswer_getTML.object[0].edoc;
        return YAML.parse(edoc);
    }
}
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
    addExportAnswerDataProxied(client, instanceUrl);
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

const PROXY_URL = "https://plugin-party-vercel.vercel.app/api/proxy";

function addExportAnswerDataProxied(client: any, instanceUrl: string) {
    (client as any).exportAnswerReportProxied = async ({ session_identifier, generation_number, file_format }: { session_identifier: string, generation_number: number, file_format: string }) => {
        const endpoint = "/api/rest/2.0/report/answer";
        const response = await fetch(PROXY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                token,
                clusterUrl: instanceUrl,
                endpoint,
                payload: {
                    session_identifier,
                    generation_number,
                    file_format,
                }
            })
        });
        return response;
    }
}


// This is a workaround until we get the public API for this
function addExportUnsavedAnswerTML(client: any, instanceUrl: string) {
    (client as any).exportUnsavedAnswerTML = async ({ session_identifier, generation_number }) => {
        const endpoint = "/prism/?op=GetUnsavedAnswerTML";
        // make a graphql request to `ThoughtspotHost/prism endpoint.
        const response = await fetch(PROXY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body: JSON.stringify({
                token,
                clusterUrl: instanceUrl,
                endpoint,
                payload: {
                    operationName: "GetUnsavedAnswerTML",
                    query: getAnswerTML,
                    variables: {
                        session: {
                            sessionId: session_identifier,
                            genNo: generation_number,
                        }
                    }
                }
            }),
        });

        const data = await response.json();
        const edoc = data.data.UnsavedAnswer_getTML.object[0].edoc;
        return YAML.parse(edoc);
    }
}
import { createBearerAuthenticationConfig, ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk"
import type { RequestContext, ResponseContext } from "@thoughtspot/rest-api-sdk"
import YAML from "yaml";
import type { Observable } from "rxjs";
import { of } from "rxjs";

export const getThoughtSpotClient = (instanceUrl: string, bearerToken: string) => {
    const config = createBearerAuthenticationConfig(
        instanceUrl,
        () => Promise.resolve(bearerToken),
    );

    config.middleware.push({
        pre: (context: RequestContext): Observable<RequestContext> => {
            const headers = context.getHeaders();
            if (!headers || !headers["Accept-Language"]) {
                context.setHeaderParam('Accept-Language', 'en-US');
            }
            return of(context);
        },
        post: (context: ResponseContext): Observable<ResponseContext> => {
            return of(context);
        }
    });
    const client = new ThoughtSpotRestApi(config);
    (client as any).instanceUrl = instanceUrl;
    addExportUnsavedAnswerTML(client, instanceUrl, bearerToken);
    addGetSessionInfo(client, instanceUrl, bearerToken);
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


// This is a workaround until we get the public API for this
function addExportUnsavedAnswerTML(client: any, instanceUrl: string, token: string) {
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

async function addGetSessionInfo(client: any, instanceUrl: string, token: string) {
    (client as any).getSessionInfo = async (): Promise<SessionInfo> => {
        const endpoint = "/prism/preauth/info";
        // make a graphql request to `ThoughtspotHost/prism endpoint.
        const response = await fetch(`${instanceUrl}${endpoint}`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "user-agent": "ThoughtSpot-ts-client",
                "Authorization": `Bearer ${token}`,
            }
        });

        const data: any = await response.json();
        const info = data.info;
        return info;
    };
}
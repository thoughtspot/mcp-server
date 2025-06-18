import { createBearerAuthenticationConfig, ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk"
import type { RequestContext, ResponseContext } from "@thoughtspot/rest-api-sdk"
import YAML from "yaml";
<<<<<<< HEAD
import type { Observable } from "rxjs";
import { of } from "rxjs";
=======
import { SessionInfo } from "./thoughtspot-service";
import { getTracer } from "../metrics/honeycomb/shared-tracer";
>>>>>>> c97eb45 (complete worker logger shell)

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
        const tracer = getTracer();
        tracer?.log("exportUnsavedAnswerTML called");
        tracer?.addData({instanceUrl});
        const endpoint = "/prism/?op=GetUnsavedAnswerTML";
        // make a graphql request to `ThoughtspotHost/prism endpoint.
        let response: any;
        const body = JSON.stringify({
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
        });
        const headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        };
        if (tracer) {
            response = await tracer.fetch(PROXY_URL, {
            method: "POST",
            headers: headers,
            body: body,
        });} else {
            response = await fetch(PROXY_URL, {
                method: "POST",
                headers: headers,
                body: body,
            });
        }
        const data = await response.json();
        const edoc = data.data.UnsavedAnswer_getTML.object[0].edoc;
        return YAML.parse(edoc);
    }
}

async function addGetSessionInfo(client: any, instanceUrl: string, token: string) {
    // const tracer = getSharedTracer();
    // console.log('tracer', tracer);
    (client as any).getSessionInfo = async (): Promise<SessionInfo> => {
        const tracer = getTracer();
        const endpoint = "/prism/preauth/info";
        tracer?.log("getSessionInfo called");
        tracer?.addData({instanceUrl});
        let response: any;
        const headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "user-agent": "ThoughtSpot-ts-client",
            "Authorization": `Bearer ${token}`,
        };
        // make a graphql request to `ThoughtspotHost/prism endpoint.
        if (tracer) {
            response = await tracer?.fetch(`${instanceUrl}${endpoint}`, {
                method: "GET",
                headers: headers,
            });
        } else {
            response = await fetch(`${instanceUrl}${endpoint}`, {
                method: "GET",
                headers: headers,
            });
        }
        const data: any = await response.json();
        const info = data.info;
        return info;
    };
}
import YAML from "yaml";
import { fetchApi } from "../../rest-utils";
import { type ClientContext, ThoughtSpotApiError } from "../../types";

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

/*
 * Using custom handler because we don't have a public API for this
 */
export async function exportUnsavedAnswerTML(
	ctx: ClientContext,
	{
		session_identifier,
		generation_number,
	}: { session_identifier: string; generation_number: number },
) {
	const endpoint = "/prism/?op=GetUnsavedAnswerTML";
	// make a graphql request to `ThoughtspotHost/prism endpoint.
	const response = await fetchApi(ctx, endpoint, {
		json: {
			operationName: "GetUnsavedAnswerTML",
			query: getAnswerTML,
			variables: {
				session: {
					sessionId: session_identifier,
					genNo: generation_number,
				},
			},
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"exportUnsavedAnswerTML",
			errorText,
		);
	}
	const data: any = await response.json();
	// GraphQL 200s can still carry errors
	if (data?.errors?.length) {
		throw new Error(
			`exportUnsavedAnswerTML GraphQL error: ${JSON.stringify(data.errors)}`,
		);
	}
	const edoc = data?.data?.UnsavedAnswer_getTML?.object?.[0]?.edoc;
	if (!edoc) {
		throw new Error("Could not extract TML edoc from response.");
	}
	return YAML.parse(edoc);
}

const getAnswerSessionQuery = `
mutation Answer__updateTokens($session: BachSessionIdInput!) {
  Answer__updateTokens(session: $session) {
    id {
      sessionId
      genNo
      acSession {
        genNo
        sessionId
      }
    }
  }
}`;

export interface AnswerSession {
	sessionId: string;
	genNo: number;
	acSession: {
		genNo: number;
		sessionId: string;
	};
}

/*
 * Using custom handler because we don't have a public API for this
 */
export async function getAnswerSession(
	ctx: ClientContext,
	{
		session_identifier,
		generation_number,
	}: {
		session_identifier: string;
		generation_number: number;
	},
): Promise<AnswerSession> {
	const endpoint = "/prism/";
	const operationName = "Answer__updateTokens";
	const response = await fetchApi(ctx, endpoint, {
		json: {
			operationName,
			query: getAnswerSessionQuery,
			variables: {
				session: {
					sessionId: session_identifier,
					genNo: generation_number,
				},
			},
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"getAnswerSession",
			errorText,
		);
	}
	const data = (await response.json()) as any;
	// GraphQL 200s can still carry errors
	if (data?.errors?.length) {
		throw new Error(
			`getAnswerSession GraphQL error: ${JSON.stringify(data.errors)}`,
		);
	}
	const session = data?.data?.Answer__updateTokens?.id;
	if (!session) {
		throw new Error("Could not extract answer session from response.");
	}
	return session;
}

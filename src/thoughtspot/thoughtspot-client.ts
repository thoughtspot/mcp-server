import {
	ThoughtSpotRestApi,
	createBearerAuthenticationConfig,
} from "@thoughtspot/rest-api-sdk";
import type {
	AgentConversation,
	RequestContext,
	ResponseContext,
} from "@thoughtspot/rest-api-sdk";
import { customAlphabet } from "nanoid";
import { of } from "rxjs";
import YAML from "yaml";
import type { SessionInfo } from "./types";

/*
 * Inject custom handlers into the ThoughtSpot client
 */
export const getThoughtSpotClient = (
	instanceUrl: string,
	bearerToken: string,
) => {
	const config = createBearerAuthenticationConfig(instanceUrl, () =>
		Promise.resolve(bearerToken),
	);

	config.middleware.push({
		pre: (context: RequestContext) => {
			const headers = context.getHeaders();
			if (!headers || !headers["Accept-Language"]) {
				context.setHeaderParam("Accept-Language", "en-US");
			}
			return of(context) as any;
		},
		post: (context: ResponseContext) => {
			return of(context) as any;
		},
	});
	const client = new ThoughtSpotRestApi(config);
	(client as any).instanceUrl = instanceUrl;
	addExportUnsavedAnswerTML(client, instanceUrl, bearerToken);
	addGetSessionInfo(client, instanceUrl, bearerToken);
	addGetAnswerSession(client, instanceUrl, bearerToken);
	addCreateAgentConversationWithAutoMode(client, instanceUrl, bearerToken);
	addSendAgentConversationMessageStreaming(client, instanceUrl, bearerToken);
	addSearchObjects(client, instanceUrl, bearerToken);
	return client;
};

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
function addExportUnsavedAnswerTML(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).exportUnsavedAnswerTML = async ({
		session_identifier,
		generation_number,
	}: { session_identifier: string; generation_number: number }) => {
		const endpoint = "/prism/?op=GetUnsavedAnswerTML";
		// make a graphql request to `ThoughtspotHost/prism endpoint.
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				operationName: "GetUnsavedAnswerTML",
				query: getAnswerTML,
				variables: {
					session: {
						sessionId: session_identifier,
						genNo: generation_number,
					},
				},
			}),
		});

		const data: any = await response.json();
		const edoc = data.data.UnsavedAnswer_getTML.object[0].edoc;
		return YAML.parse(edoc);
	};
}

/*
 * Using custom handler because we don't have a public API for this
 */
async function addGetSessionInfo(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).getSessionInfo = async (): Promise<SessionInfo> => {
		const endpoint = "/prism/preauth/info";
		// make a graphql request to `ThoughtspotHost/prism endpoint.
		const response = await fetch(`${instanceUrl}${endpoint}`, {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
		});

		const data: any = await response.json();
		const info = data.info;
		return info;
	};
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
function addGetAnswerSession(client: any, instanceUrl: string, token: string) {
	(client as any).getAnswerSession = async ({
		session_identifier,
		generation_number,
	}: {
		session_identifier: string;
		generation_number: number;
	}): Promise<AnswerSession> => {
		const endpoint = "/prism/";
		const operationName = "Answer__updateTokens";
		const fetchOptions = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				operationName,
				query: getAnswerSessionQuery,
				variables: {
					session: {
						sessionId: session_identifier,
						genNo: generation_number,
					},
				},
			}),
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, fetchOptions);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`getAnswerSession failed with status ${response.status}: ${errorText}`,
			);
		}
		const data = (await response.json()) as any;
		const session = data?.data?.Answer__updateTokens?.id;
		if (!session) {
			throw new Error("Could not extract answer session from response.");
		}
		return session;
	};
}

/*
 * Using custom handler because we don't have support for Auto Mode through the public API yet
 */
function addCreateAgentConversationWithAutoMode(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).createAgentConversationWithAutoMode = async ({
		dataSourceId,
	}: {
		dataSourceId?: string;
	}): Promise<AgentConversation> => {
		const endpoint = "/conversation/v2/";
		const fetchOptions = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				context: dataSourceId
					? {
							type: "worksheet",
							worksheet_context: {
								worksheet_id: dataSourceId,
							},
						}
					: {
							type: "empty",
						},
				conv_settings: {
					enable_nls: true,
					enable_why: true,
					save_chat_enabled: false,
					enable_tool_permissions: false,
					enable_search_datasets: !dataSourceId,
					enable_auto_select_dataset: !dataSourceId,
				},
			}),
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, fetchOptions);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`createAgentConversationWithAutoMode failed with status ${response.status}: ${errorText}`,
			);
		}

		const data = (await response.json()) as AgentConversation;
		return data;
	};
}

const searchObjectsQuery = `
query GetEurekaResults($params: Input_eureka_SearchRequest) {
  queryRequest(request: $params) {
    ...eurekaResults
    __typename
  }
}

fragment eurekaResults on eureka_SearchResponse {
  facets {
    facetType
    facetValue
    facetValues {
      id
      resultCount
      name
      __typename
    }
    __typename
  }
  requestIdentifiers {
    apiRequestId
    appActivityId
    __typename
  }
  sageQuerySuggestions {
    llmReasoning {
      assumptions
      clarifications
      interpretation
      __typename
    }
    tokens
    tmlTokens
    worksheetId
    description
    title
    tmlTokens
    formulaInfo {
      name
      expression
      __typename
    }
    parameters {
      dataType
      defaultValue {
        column {
          id {
            created
            description
            guid
            indexVersion
            modified
            name
            __typename
          }
          joinPaths {
            id {
              created
              description
              guid
              indexVersion
              modified
              name
              __typename
            }
            isConnected
            leafTable {
              created
              description
              guid
              indexVersion
              modified
              name
              __typename
            }
            rootTable {
              created
              description
              guid
              indexVersion
              modified
              name
              __typename
            }
            __typename
          }
          schemaTableId
          table {
            created
            description
            guid
            indexVersion
            modified
            name
            __typename
          }
          __typename
        }
        constant {
          boolValue
          dateEpochValue
          doubleValue
          intValue
          isNull
          normalize
          strValue
          __typename
        }
        dataType
        exprClass
        exprRef {
          refId {
            created
            description
            guid
            indexVersion
            modified
            name
            __typename
          }
          __typename
        }
        expressionId
        formatingType
        __typename
      }
      header {
        authorDisplayName
        authorGuid
        authorName
        created
        databaseStripe
        deleted
        description
        generationNum
        hidden
        idGuid
        isVersioningEnabled
        lenientDiscoverability
        metadataType
        modified
        modifiedBy
        name
        objId
        ownerGuid
        schemaStripe
        type
        __typename
      }
      linkedParameters
      listColumnId
      listConfig {
        listChoice {
          displayName
          value {
            column {
              id {
                created
                description
                guid
                indexVersion
                modified
                name
                __typename
              }
              joinPaths {
                id {
                  created
                  description
                  guid
                  indexVersion
                  modified
                  name
                  __typename
                }
                isConnected
                leafTable {
                  created
                  description
                  guid
                  indexVersion
                  modified
                  name
                  __typename
                }
                rootTable {
                  created
                  description
                  guid
                  indexVersion
                  modified
                  name
                  __typename
                }
                __typename
              }
              schemaTableId
              table {
                created
                description
                guid
                indexVersion
                modified
                name
                __typename
              }
              __typename
            }
            constant {
              boolValue
              dateEpochValue
              doubleValue
              intValue
              isNull
              normalize
              strValue
              __typename
            }
            dataType
            exprClass
            exprRef {
              refId {
                created
                description
                guid
                indexVersion
                modified
                name
                __typename
              }
              __typename
            }
            expressionId
            formatingType
            function {
              hasVarargs
              isAggregate
              name
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      rangeConfig {
        includeMax
        includeMin
        rangeMax {
          column {
            id {
              created
              description
              guid
              indexVersion
              modified
              name
              __typename
            }
            joinPaths {
              id {
                created
                description
                guid
                indexVersion
                modified
                name
                __typename
              }
              isConnected
              leafTable {
                created
                description
                guid
                indexVersion
                modified
                name
                __typename
              }
              rootTable {
                created
                description
                guid
                indexVersion
                modified
                name
                __typename
              }
              __typename
            }
            schemaTableId
            table {
              created
              description
              guid
              indexVersion
              modified
              name
              __typename
            }
            __typename
          }
          constant {
            boolValue
            dateEpochValue
            doubleValue
            intValue
            isNull
            normalize
            strValue
            __typename
          }
          dataType
          exprClass
          exprRef {
            refId {
              created
              description
              guid
              indexVersion
              modified
              name
              __typename
            }
            __typename
          }
          expressionId
          formatingType
          __typename
        }
        rangeMin {
          column {
            id {
              created
              description
              guid
              indexVersion
              modified
              name
              __typename
            }
            joinPaths {
              id {
                created
                description
                guid
                indexVersion
                modified
                name
                __typename
              }
              isConnected
              leafTable {
                created
                description
                guid
                indexVersion
                modified
                name
                __typename
              }
              rootTable {
                created
                description
                guid
                indexVersion
                modified
                name
                __typename
              }
              __typename
            }
            schemaTableId
            table {
              created
              description
              guid
              indexVersion
              modified
              name
              __typename
            }
            __typename
          }
          constant {
            boolValue
            dateEpochValue
            doubleValue
            intValue
            isNull
            normalize
            strValue
            __typename
          }
          dataType
          exprClass
          exprRef {
            refId {
              created
              description
              guid
              indexVersion
              modified
              name
              __typename
            }
            __typename
          }
          expressionId
          formatingType
          __typename
        }
        __typename
      }
      sapParameterName
      __typename
    }
    sageQueryTokens {
      additions {
        phrase {
          isCompletePhrase
          numTokens
          phraseType
          startIndex
          __typename
        }
        tokens {
          token
          dataType
          typeEnum
          guid
          tokenMetadata {
            name
            __typename
          }
          __typename
        }
        __typename
      }
      phrases {
        isCompletePhrase
        numTokens
        phraseType
        startIndex
        __typename
      }
      removals {
        phrase {
          isCompletePhrase
          numTokens
          phraseType
          startIndex
          __typename
        }
        tokens {
          token
          dataType
          typeEnum
          guid
          tokenMetadata {
            name
            __typename
          }
          __typename
        }
        __typename
      }
      tokens {
        token
        dataType
        typeEnum
        guid
        tokenMetadata {
          name
          __typename
        }
        __typename
      }
      __typename
    }
    tmlPhrases
    ambiguousPhrases {
      alternativePhrases {
        phraseType
        token {
          token
          dataType
          typeEnum
          guid
          tokenMetadata {
            name
            __typename
          }
          __typename
        }
        __typename
      }
      ambiguityType
      token {
        token
        dataType
        typeEnum
        guid
        tokenMetadata {
          name
          __typename
        }
        __typename
      }
      __typename
    }
    ambiguousTokens {
      alternativeTokens {
        token
        dataType
        typeEnum
        guid
        tokenMetadata {
          name
          deprecatedTableGuid
          deprecatedTableName
          isFormula
          rootTables {
            created
            description
            guid
            indexVersion
            modified
            name
            __typename
          }
          schemaTableUserDefinedName
          table {
            created
            description
            guid
            indexVersion
            modified
            name
            __typename
          }
          __typename
        }
        __typename
      }
      ambiguityType
      token {
        token
        dataType
        typeEnum
        guid
        tokenMetadata {
          name
          __typename
        }
        __typename
      }
      __typename
    }
    sessionId
    genNo
    stateKey {
      generationNumber
      transactionId
      __typename
    }
    subQueries {
      tokens
      cohortConfig {
        anchorColumnId
        cohortAnswerGuid
        cohortGroupingType
        cohortGuid
        cohortType
        combineNonGroupValues
        description
        groupExcludedQueryValues
        hideExcludedQueryValues
        isEditable
        name
        nullOutputValue
        returnColumnId
        __typename
      }
      formulas {
        name
        expression
        __typename
      }
      __typename
    }
    visualizationSuggestion {
      chartType
      displayMode
      axisConfigs {
        category
        color
        hidden
        size
        sort
        x
        y
        __typename
      }
      usersVizIntentApplied
      customChartConfigs {
        dimensions {
          columns
          key
          __typename
        }
        key
        __typename
      }
      customChartGuid
      __typename
    }
    tableData {
      columnDataLite {
        columnId
        columnDataType
        dataValue
        columnName
        __typename
      }
      __typename
    }
    warningType
    cached
    warningDetails {
      warningType
      __typename
    }
    __typename
  }
  results {
    objectSecurityInfo {
      objectType
      objectId
      objectIdForDeletionCheck
      objectTypeForDeletionCheck
      isD13ySourced
      offset
      __typename
    }
    searchAnswer {
      ...eurekaAnswer
      __typename
    }
    searchPinboardViz {
      answer {
        ...eurekaAnswer
        __typename
      }
      pinboardHeader {
        id
        title
        __typename
      }
      __typename
    }
    searchPinboard {
      header {
        ...header
        __typename
      }
      usageInfo {
        ...usageInfo
        __typename
      }
      answers {
        ...eurekaAnswer
        __typename
      }
      vizCount {
        charts
        metrics
        tables
        __typename
      }
      __typename
    }
    searchWorksheet {
      header {
        ...header
        __typename
      }
      usageInfo {
        ...usageInfo
        __typename
      }
      __typename
    }
    snippetInfo {
      titleSnippet {
        snippetString
        highlights {
          start
          end
          __typename
        }
        __typename
      }
      descriptionSnippet {
        snippetString
        highlights {
          start
          end
          __typename
        }
        __typename
      }
      sageQuerySnippet {
        phrase {
          isCompletePhrase
          numTokens
          phraseType
          startIndex
          __typename
        }
        token {
          token
          dataType
          typeEnum
          __typename
        }
        __typename
      }
      sageQuerySnippetWithHighlights {
        highlights {
          start
          end
          __typename
        }
        phraseType
        phraseValue
        __typename
      }
      __typename
    }
    score
    debugInfo
    resultType
    sageQuery
    __typename
  }
  version
  nextPageOffset
  batchSizeRequired
  isFinalPage
  totalResults
  totalFacetResultCount
  errorCode
  debugInfo {
    fewShotExamples {
      chartType
      formulas {
        name
        expression
        __typename
      }
      id
      mappingId
      nlQuery
      nlQueryConcepts
      sageQuery
      scope
      sql
      tml
      feedbackType
      __typename
    }
    __typename
  }
  __typename
}

fragment eurekaAnswer on eureka_AnswerResult {
  header {
    ...header
    __typename
  }
  usageInfo {
    ...usageInfo
    __typename
  }
  preferredViz {
    ...visualizationMetadata
    __typename
  }
  worksheetInfo {
    ...worksheetInfo
    __typename
  }
  formatted {
    phrase {
      isCompletePhrase
      numTokens
      phraseType
      startIndex
      __typename
    }
    token {
      token
      typeEnum
      __typename
    }
    __typename
  }
  __typename
}

fragment header on eureka_Header {
  id
  title
  description
  authorGuid
  authorName
  createdOn
  isVerified
  modifiedOn
  modifiedByUserGuid
  modifiedByUserName
  tagIds
  __typename
}

fragment usageInfo on eureka_UsageInfo {
  favouriteCount
  viewCount
  __typename
}

fragment visualizationMetadata on eureka_VisualizationMetadata {
  vizType
  chartType
  vizSnapshotRequestData {
    parentReportbookGuid
    parentType
    version
    vizGuid
    __typename
  }
  __typename
}

fragment worksheetInfo on eureka_WorksheetInfo {
  id
  name
  __typename
}`;

export interface SearchObjectHeader {
	id: string;
	name: string;
	type: string;
	owner: string;
	description: string;
	tags: string[];
	last_modified?: number;
	last_viewed?: number | null;
	verified: boolean;
	frame_url: string;
	match_reason: string;
	confidence?: number;
}

export interface SearchObjectsParams {
	query: string;
	types?: string[];
	owner?: string;
	tag?: string;
	modifiedSince?: number;
	verifiedOnly?: boolean;
	limit?: number;
	cursor?: string;
}

export interface SearchObjectsResult {
	objects: SearchObjectHeader[];
	next_cursor: string | null;
	// Client-generated correlation ids sent on the upstream call as the
	// x-request-id / x-prism-trace-id headers and echoed back here, so the same
	// id can be traced across this server and ThoughtSpot's server-side logs.
	request_id: string;
	trace_id: string;
}

// Friendly object-type names accepted by the `types` filter, mapped to the
// OBJECT_TYPE_FACET values the Eureka backend understands.
const OBJECT_TYPE_FACET_MAP: Record<string, string> = {
	liveboard: "pinboard",
	pinboard: "pinboard",
	dashboard: "pinboard",
	answer: "answer",
	worksheet: "worksheet",
	table: "worksheet",
	model: "worksheet",
};

// Build a deep link to the object in the ThoughtSpot UI from its result type.
function buildFrameUrl(
	instanceUrl: string,
	resultType: string,
	id: string,
	parentId?: string,
): string {
	const base = instanceUrl.replace(/\/$/, "");
	switch (resultType) {
		case "PINBOARD_VIZ_RESULT":
			return `${base}/#/pinboard/${parentId ?? id}/${id}`;
		case "ANSWER_RESULT":
			return `${base}/#/saved-answer/${id}`;
		case "WORKSHEET_RESULT":
			return `${base}/#/data/tables/${id}`;
		default:
			return `${base}/#/pinboard/${id}`;
	}
}

// Derive a human-readable match reason from the Eureka snippet metadata.
function deriveMatchReason(snippetInfo: any): string {
	if (snippetInfo?.titleSnippet?.highlights?.length) {
		return "Matched in title";
	}
	if (snippetInfo?.descriptionSnippet?.highlights?.length) {
		return "Matched in description";
	}
	const tokens = (snippetInfo?.sageQuerySnippet?.token ?? [])
		.map((t: any) => t?.token)
		.filter(Boolean);
	if (tokens.length) {
		return `Matched query terms: ${tokens.join(", ")}`;
	}
	return "Matched search term";
}

/*
 * Using custom handler because we don't have a public API for full-text object search.
 * This mirrors the Eureka search used by the ThoughtSpot UI search bar.
 */
function addSearchObjects(client: any, instanceUrl: string, token: string) {
	(client as any).searchObjects = async ({
		query,
		types,
		owner,
		tag,
		modifiedSince,
		verifiedOnly,
		limit = 10,
		cursor,
	}: SearchObjectsParams): Promise<SearchObjectsResult> => {
		const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;

		// Filters the Eureka backend can apply server-side via facetSelections.
		const facetSelections: { facetType: string; facetValue: string[] }[] = [];
		if (types?.length) {
			const facetValue = [
				...new Set(
					types.map(
						(t) => OBJECT_TYPE_FACET_MAP[t.toLowerCase()] ?? t.toLowerCase(),
					),
				),
			];
			facetSelections.push({ facetType: "OBJECT_TYPE_FACET", facetValue });
		}
		if (verifiedOnly) {
			facetSelections.push({ facetType: "IS_VERIFIED", facetValue: ["true"] });
		}

		// Correlation ids we mint per call and send as x-request-id /
		// x-prism-trace-id. ThoughtSpot does not return these — it generates its
		// own — so we generate and echo them back to enable cross-system tracing.
		const requestId = globalThis.crypto.randomUUID();
		const traceId = globalThis.crypto.randomUUID();

		const endpoint = "/prism/?op=GetEurekaResults";
		const fetchOptions = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				// The Eureka backend derives the request locale from this header.
				// Without it the server falls back to "*" and 500s with
				// "IllegalArgumentException: Invalid locale format: *".
				"accept-language": "en-US",
				"x-request-id": requestId,
				"x-prism-trace-id": traceId,
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				operationName: "GetEurekaResults",
				query: searchObjectsQuery,
				variables: {
					params: {
						batchSize: limit,
						// Request the STICKERS facet so tag ids on each result can be
						// resolved to human-readable tag names.
						desiredFacets: [{ facetType: "STICKERS", facetValue: [] }],
						facetSelections,
						maxPinboardVizCount: 5,
						filterSelections: [],
						offset,
						query,
						removeDuplicates: true,
						sortBy: [],
						currentPageNumber: Math.floor(offset / limit) + 1,
						searchOption: "SEARCH_RESULTS",
					},
				},
			}),
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, fetchOptions);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`searchObjects failed with status ${response.status}: ${errorText}`,
			);
		}

		const data = (await response.json()) as any;

		// The Eureka endpoint returns HTTP 200 even on query-level failures,
		// reporting them in a top-level `errors` array (with `data` null) or in
		// `queryRequest.errorCode`. Without this check those surface as an empty
		// result set and get reported as a successful "0 objects found".
		const graphqlError = data?.errors?.[0]?.message;
		const errorCode = data?.data?.queryRequest?.errorCode;
		if (graphqlError || errorCode) {
			throw new Error(
				`searchObjects failed: ${graphqlError ?? `errorCode ${errorCode}`}`,
			);
		}

		const queryRequest = data?.data?.queryRequest ?? {};
		const results = queryRequest.results ?? [];

		// Build a sticker id -> name map so tagIds can be surfaced as tag names.
		const stickerNames: Record<string, string> = {};
		for (const facet of queryRequest.facets ?? []) {
			if (facet?.facetType === "STICKERS") {
				for (const value of facet.facetValues ?? []) {
					if (value?.id) {
						stickerNames[value.id] = value.name ?? value.id;
					}
				}
			}
		}

		let objects: SearchObjectHeader[] = results
			.map((result: any): SearchObjectHeader | null => {
				// Each result carries every sub-object (searchAnswer, searchPinboard,
				// searchWorksheet, searchPinboardViz) but only the one matching
				// resultType is populated; the rest are placeholders with an empty
				// header id. Pick the first header that actually has an id.
				const candidates = [
					result?.searchAnswer?.header,
					result?.searchPinboard?.header,
					result?.searchWorksheet?.header,
					result?.searchPinboardViz?.answer?.header,
					result?.searchPinboardViz?.pinboardHeader,
				];
				const header = candidates.find((h) => h?.id);
				// Prefer the object's own header id. objectSecurityInfo.objectId
				// points at the containing liveboard for viz results, which would
				// make every viz in a liveboard collapse to the same id — so it is
				// only a fallback for objects that expose no populated header.
				const id = header?.id ?? result?.objectSecurityInfo?.objectId;
				if (!id) {
					return null;
				}
				const tags = (header?.tagIds ?? []).map(
					(tagId: string) => stickerNames[tagId] ?? tagId,
				);
				return {
					id,
					name: header?.title ?? "",
					type:
						result?.objectSecurityInfo?.objectType ?? result?.resultType ?? "",
					owner: header?.authorName ?? "",
					description: header?.description ?? "",
					tags,
					last_modified: header?.modifiedOn,
					// Eureka search does not expose a per-user last-viewed timestamp.
					last_viewed: null,
					verified: header?.isVerified ?? false,
					frame_url: buildFrameUrl(
						instanceUrl,
						result?.resultType ?? "",
						id,
						result?.objectSecurityInfo?.objectId,
					),
					match_reason: deriveMatchReason(result?.snippetInfo),
					confidence: result?.score,
				};
			})
			.filter(
				(obj: SearchObjectHeader | null): obj is SearchObjectHeader =>
					obj !== null,
			);

		// owner, tag and modified_since are not reliably expressible through the
		// Eureka request schema, so they are applied to the returned page here.
		if (owner) {
			const needle = owner.toLowerCase();
			objects = objects.filter((o) => o.owner.toLowerCase().includes(needle));
		}
		if (tag) {
			const needle = tag.toLowerCase();
			objects = objects.filter((o) =>
				o.tags.some((t) => t.toLowerCase().includes(needle)),
			);
		}
		if (modifiedSince) {
			objects = objects.filter((o) => (o.last_modified ?? 0) >= modifiedSince);
		}

		// A full page of raw results implies there may be more to fetch.
		const next_cursor =
			results.length === limit ? String(offset + limit) : null;

		return {
			objects,
			next_cursor,
			request_id: requestId,
			trace_id: traceId,
		};
	};
}

/*
 * Generator initialized once at module level so the internal buffers and state
 * are pre-computed once and reused across calls — important in streaming scenarios
 * where multiple IDs may be generated in quick succession.
 * This will become optional in future
 */
const generateNanoID = customAlphabet(
	"_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
	12,
);

/*
 * Using custom handler for two reasons:
 * 1. The REST API SDK doesn't have streaming response support
 * 2. The public API itself is exhibiting higher latency than the private API for establishing the
 *    initial connection, prior to starting the streaming response
 */
function addSendAgentConversationMessageStreaming(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).sendAgentConversationMessageStreaming = async ({
		conversation_identifier,
		message,
	}: {
		conversation_identifier: string;
		message: string;
	}): Promise<Response> => {
		// Encoding for safety, though for valid IDs it should not make a difference
		const endpoint = `/conversation/v2/${encodeURIComponent(conversation_identifier)}/query`;
		const fetchOptions = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: "spotter", // TODO(Rifdhan) support deep analysis mode
				id: generateNanoID(),
				messages: [
					{
						type: "text",
						// TODO(Rifdhan) this will become optional, can remove in the future
						id: Math.random().toString(36).substring(2, 12),
						value: message,
					},
				],
			}),
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, fetchOptions);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`sendAgentConversationMessageStreaming failed with status ${response.status}: ${errorText}`,
			);
		}

		return response;
	};
}

// GraphQL query for the private Eureka object search (no public REST equivalent),
// trimmed to the fields the search_objects mapper actually reads.
export const searchObjectsQuery = `
query GetEurekaResults($params: Input_eureka_SearchRequest) {
  queryRequest(request: $params) {
    facets {
      facetType
      facetValues {
        id
        name
      }
    }
    results {
      objectSecurityInfo {
        objectType
        objectId
      }
      searchAnswer {
        ...eurekaAnswer
      }
      searchPinboardViz {
        answer {
          ...eurekaAnswer
        }
        pinboardHeader {
          id
          title
        }
      }
      searchPinboard {
        header {
          ...header
        }
      }
      searchWorksheet {
        header {
          ...header
        }
      }
      snippetInfo {
        titleSnippet {
          highlights {
            start
            end
          }
        }
        descriptionSnippet {
          highlights {
            start
            end
          }
        }
        sageQuerySnippet {
          token {
            token
          }
        }
      }
      score
      resultType
      # Human-readable sage/TML tokens; surfaced as the query field for answers.
      sageQuery
    }
    isFinalPage
    totalResults
    errorCode
    nextPageOffset
    batchSizeRequired
  }
}

fragment eurekaAnswer on eureka_AnswerResult {
  header {
    ...header
  }
}

fragment header on eureka_Header {
  id
  title
  description
  authorName
  isVerified
  modifiedOn
  tagIds
}`;

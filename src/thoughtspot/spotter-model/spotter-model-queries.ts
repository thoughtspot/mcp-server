/**
 * bach worksheet-editor GraphQL operations used by the Spotter Model flow. These are the same
 * mutations the ThoughtSpot modelling UI sends; field selections are trimmed to what we consume.
 */

// Minimal bach mutation to name + persist the worksheet the model session built. We only select the
// saved worksheet header (its guid is the model id); the full client query pulls the whole model +
// fragments, which we don't need for save.
export const SAVE_WORKSHEET_QUERY = `
mutation WorksheetOperation($session: BachSessionIdInput!, $baseRequests: [EditWorksheetBaseRequest!]!) {
  Worksheet__operation(session: $session, baseRequests: $baseRequests) {
    id { sessionId genNo }
    worksheetHeader { guid displayName }
  }
}`;

// Read the current materialized worksheet model via the bach editor — used to render an accurate,
// structured finalize summary (table/join/column counts + names) instead of parsing model-generated
// prose. Field selection is a trimmed subset of the real client's worksheetModel fragment.
export const FETCH_WORKSHEET_MODEL_QUERY = `
mutation WorksheetOperation($session: BachSessionIdInput!, $baseRequests: [EditWorksheetBaseRequest!]!) {
  Worksheet__operation(session: $session, baseRequests: $baseRequests) {
    id { sessionId genNo }
    worksheetModel {
      header { guid displayName }
      columnGroup {
        schemaTableId
        header { displayName }
        worksheetColumn { header { displayName } dataType }
      }
      schemaJoins { srcSchemaTableId destSchemaTableId joinType }
      schemaGraphProto { schemaTables { schemaTableId userDefinedName } }
    }
  }
}`;

export const WORKSHEET_OPERATION_NAME = "WorksheetOperation";

export const REQUEST_TYPES = {
	updateNameDescription: "UPDATE_WORKSHEET_NAME_DESCRIPTION_REQUEST",
	saveWorksheet: "SAVE_WORKSHEET_REQUEST",
	fetchWorksheetModel: "FETCH_WORKSHEET_MODEL_REQUEST",
} as const;

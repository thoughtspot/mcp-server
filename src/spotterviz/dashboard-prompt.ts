/**
 * Composes the prompt sent to the dashboard designer for one turn.
 *
 * The designer is built for an interactive chat surface: it is instructed to act as a
 * collaborative assistant rather than an autonomous executor, to ask before choosing a data
 * source, and never to infer anything the user did not say. Here there is no interactive user to
 * answer, so an under-specified request comes back as a question instead of a dashboard.
 *
 * The preamble below narrows that behaviour rather than trying to override it wholesale. It grants
 * autonomy over the decisions we genuinely do not need a human for (layout, grouping, ordering,
 * sizing, styling) while leaving the designer free to ask about anything genuinely missing. Data
 * source selection is the one clarification worth pre-empting, because it is the most common: the
 * designer can find data sources itself, so it is told to.
 */

const AUTONOMY_PREAMBLE = `You are being driven by an automated integration. There is no person in this conversation who can answer follow-up questions, so treat this as a single-shot request.

Make all layout, grouping, tab, ordering, sizing and styling decisions yourself using your own judgement, and publish them without asking for confirmation. Do not ask which data source to use. If one is given below, use it. Otherwise, when the liveboard already has charts, build new charts from the data sources those charts use; when it is empty, pick the most relevant data source yourself.

If something essential is genuinely missing and you cannot proceed at all, reply with one short sentence stating exactly what you need, and make no changes.`;

/**
 * For a dashboard built from a description: the person confirms the data source and plan before
 * anything is built, as in SpotterViz itself. The confirmation arrives as a follow-up turn on the
 * same task, which then runs under AUTONOMY_PREAMBLE.
 */
const PLAN_PREAMBLE = `You are being driven by an automated integration. A person will review your proposal through it before anything is built.

Do not create, change or publish anything in this turn. Choose the data source you would use: the one given below if one is given, otherwise the most relevant one. Then reply with the data source you chose and your plan for the dashboard, and stop to wait for confirmation.`;

/**
 * Used when the caller supplied answers but no styling preferences of their own.
 *
 * Assembling answers into a liveboard produces a uniform grid in array order with no grouping or
 * styling, which is not something anyone wants to share. Before these tools existed the calling
 * agent was instructed to follow every create with a styling pass; this preserves that outcome
 * without requiring the agent to know it should ask.
 */
export const DEFAULT_LAYOUT_REQUEST =
	"Make the liveboard formatted well by arranging the answers in groups if needed, create tabs if necessary and style the liveboard and charts to be coherent.";

export interface ComposeCreatePromptParams {
	title: string;
	/** Caller's description of the dashboard. Falls back to DEFAULT_LAYOUT_REQUEST when absent. */
	instructions?: string;
	dataSourceId?: string;
	/** True when the liveboard already has charts assembled from a prior analysis. */
	hasExistingAnswers: boolean;
}

export interface ComposeModifyPromptParams {
	instructions: string;
	dataSourceId?: string;
}

function dataSourceLine(dataSourceId?: string): string[] {
	return dataSourceId
		? [`Data source to use for any new charts: ${dataSourceId}`]
		: [];
}

export function composeCreatePrompt(params: ComposeCreatePromptParams): string {
	const { title, instructions, dataSourceId, hasExistingAnswers } = params;

	if (!hasExistingAnswers) {
		return [
			PLAN_PREAMBLE,
			"",
			"This liveboard is empty.",
			`Liveboard title: ${title}`,
			...dataSourceLine(dataSourceId),
			"",
			"What is wanted:",
			instructions?.trim() || DEFAULT_LAYOUT_REQUEST,
		].join("\n");
	}

	return [
		AUTONOMY_PREAMBLE,
		"",
		"This liveboard already contains the charts that were just created for it. Organise and style them to match the request below. Add further charts only if the request explicitly calls for something that is missing.",
		"",
		`Liveboard title: ${title}`,
		...dataSourceLine(dataSourceId),
		"",
		"What is wanted:",
		instructions?.trim() || DEFAULT_LAYOUT_REQUEST,
	].join("\n");
}

export function composeModifyPrompt(params: ComposeModifyPromptParams): string {
	const { instructions, dataSourceId } = params;

	return [
		AUTONOMY_PREAMBLE,
		"",
		"Apply the following change to this liveboard.",
		...dataSourceLine(dataSourceId),
		"",
		"What is wanted:",
		instructions,
	].join("\n");
}

/** The person has seen the plan from a create's planning turn and wants it built. */
export function composeConfirmPlanPrompt(changes?: string): string {
	return [
		AUTONOMY_PREAMBLE,
		"",
		"The person reviewed the data source and plan you proposed and confirmed it. Build the dashboard now, applying any changes below, then organise and style it.",
		"",
		"Changes to the plan:",
		changes?.trim() || "None. Build it as planned.",
	].join("\n");
}

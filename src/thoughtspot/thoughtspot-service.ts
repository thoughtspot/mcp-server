import type { ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk";
import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace, context } from "@opentelemetry/api";
import { withSpan, WithSpan } from "../metrics/tracing/tracing-utils";


/**
 * Main ThoughtSpot service class using decorator pattern for tracing
 */
export class ThoughtSpotService {
    constructor(private client: ThoughtSpotRestApi) {}

    /**
     * Get relevant questions for a given query and data sources
     */
    @WithSpan('get-relevant-questions')
    async getRelevantQuestions(
        query: string,
        sourceIds: string[],
        additionalContext: string
    ): Promise<{ questions: { question: string, datasourceId: string }[], error: Error | null }> {
        const span = trace.getSpan(context.active());
        
        try {
            additionalContext = additionalContext || '';
            span?.setAttribute("sourceIds", sourceIds.join(","));
            span?.setAttribute("query", query);
            console.log("[DEBUG] Getting relevant questions for query: ", query, " and datasource: ", sourceIds);
            span?.addEvent("get-decomposed-query");
            
            const resp = await this.client.queryGetDecomposedQuery({
                nlsRequest: {
                    query: query,
                },
                content: [
                    additionalContext,
                ],
                worksheetIds: sourceIds,
                maxDecomposedQueries: 5,
            })
            
            const questions = resp.decomposedQueryResponse?.decomposedQueries?.map((q) => ({
                question: q.query!,
                datasourceId: q.worksheetId!,
            })) || [];
            
            span?.setStatus({ code: SpanStatusCode.OK, message: "Relevant questions found" });
            span?.setAttribute("questions_count", questions.length);
            
            return {
                questions,
                error: null,
            }
        } catch (error) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
            console.error("Error getting relevant questions: ", error, "sourceIds: ", sourceIds, "instanceUrl: ", (this.client as any).instanceUrl);
            return {
                questions: [],
                error: error as Error,
            }
        }
    }

    /**
     * Get answer data for a specific question
     */
    @WithSpan('get-answer-data')
    private async getAnswerData(
        question: string,
        session_identifier: string,
        generation_number: number
    ): Promise<string> {
        const span = trace.getSpan(context.active());
        
        try {
            span?.setAttribute("question", question);
            span?.setAttribute("session_identifier", session_identifier);
            span?.setAttribute("generation_number", generation_number);
            
            console.log("[DEBUG] Getting Data for question: ", question, "instanceUrl: ", (this.client as any).instanceUrl);
            
            const data = await this.client.exportAnswerReport({
                session_identifier,
                generation_number,
                file_format: "CSV",
            })
            
            let csvData = await data.text();
            // get only the first 100 lines of the csv data
            csvData = csvData.split('\n').slice(0, 100).join('\n');
            
            span?.setAttribute("csv_lines", csvData.split('\n').length);
            return csvData;
        } catch (error) {
            console.error("Error getting answer Data: ", error, "instanceUrl: ", (this.client as any).instanceUrl);
            throw error;
        }
    }

    /**
     * Get TML for a specific answer
     */
    @WithSpan('get-answer-tml')
    private async getAnswerTML(
        question: string,
        session_identifier: string,
        generation_number: number
    ): Promise<any> {
        const span = trace.getSpan(context.active());
        
        try {
            span?.setAttribute("question", question);
            span?.setAttribute("session_identifier", session_identifier);
            
            console.log("[DEBUG] Getting TML for question: ", question);
            const tml = await (this.client as any).exportUnsavedAnswerTML({
                session_identifier,
                generation_number,
            })
            return tml;
        } catch (error) {
            console.error("Error getting answer TML: ", error);
            return null;
        }
    }

    /**
     * Get answer for a specific question
     */
    @WithSpan('get-answer-for-question')
    async getAnswerForQuestion(
        question: string,
        sourceId: string,
        shouldGetTML: boolean
    ): Promise<any> {
        const span = trace.getSpan(context.active());
        
        span?.setAttribute("sourceId", sourceId);
        span?.setAttribute("shouldGetTML", shouldGetTML);
        span?.setAttribute("question", question);
        
        console.log("[DEBUG] Getting answer for question: ", question);
        
        try {
            const answer = await this.client.singleAnswer({
                query: question,
                metadata_identifier: sourceId,
            })

            const { session_identifier, generation_number } = answer as any;
            span?.setAttribute("session_identifier", session_identifier);
            span?.setAttribute("generation_number", generation_number);

            const [data, tml] = await Promise.all([
                this.getAnswerData(question, session_identifier, generation_number),
                shouldGetTML
                    ? this.getAnswerTML(question, session_identifier, generation_number)
                    : Promise.resolve(null)
            ])

            return {
                question,
                ...answer,
                data,
                tml,
                error: null,
            };
        } catch (error) {
            console.error("Error getting answer for question: ", question, " and sourceId: ", sourceId, " and shouldGetTML: ", shouldGetTML, " and error: ", error, "instanceUrl: ", (this.client as any).instanceUrl);
            return {
                error: error as Error,
            };
        }
    }

    /**
     * Fetch TML and create liveboard
     */
    @WithSpan('fetch-tml-and-create-liveboard')
    async fetchTMLAndCreateLiveboard(name: string, answers: any[]): Promise<{ url?: string; error: Error | null }> {
        const span = trace.getSpan(context.active());
        
        try {
            span?.setAttribute("liveboard_name", name);
            span?.setAttribute("answers_count", answers.length);
            
            const tmls = await Promise.all(answers.map((answer) => 
                this.getAnswerTML(answer.question, answer.session_identifier, answer.generation_number)
            ));
            
            answers.forEach((answer, idx) => {
                answer.tml = tmls[idx];
            });

            const liveboardUrl = await this.createLiveboard(name, answers);
            return {
                url: liveboardUrl,
                error: null,
            }
        } catch (error) {
            console.error("Error fetching TML and creating liveboard: ", error);
            return {
                error: error as Error,
            }
        }
    }

    /**
     * Create liveboard from answers
     */
    @WithSpan('create-liveboard')
    async createLiveboard(name: string, answers: any[]): Promise<string> {
        const span = trace.getSpan(context.active());
        
        span?.addEvent("createLiveboard");
        span?.setAttribute("liveboard_name", name);
        span?.setAttribute("total_answers", answers.length);
        
        answers = answers.filter((answer) => answer.tml);
        span?.setAttribute("answers_with_tml", answers.length);
        
        const tml = {
            liveboard: {
                name,
                visualizations: answers.map((answer, idx) => ({
                    id: `Viz_${idx}`,
                    answer: {
                        ...answer.tml.answer,
                        name: answer.question,
                    },
                })),
                layout: {
                    tiles: answers.map((answer, idx) => ({
                        visualization_id: `Viz_${idx}`,
                        size: 'MEDIUM_SMALL'
                    }))
                },
            }
        };

        const resp = await this.client.importMetadataTML({
            metadata_tmls: [JSON.stringify(tml)],
            import_policy: "ALL_OR_NONE",
        })

        const liveboardUrl = `${(this.client as any).instanceUrl}/#/pinboard/${resp[0].response.header.id_guid}`;
        span?.setAttribute("liveboard_url", liveboardUrl);
        
        return liveboardUrl;
    }

    /**
     * Get data sources
     */
    @WithSpan('get-data-sources')
    async getDataSources(): Promise<DataSource[]> {
        const span = trace.getSpan(context.active());
        
        span?.addEvent("get-data-sources");
        
        const resp = await this.client.searchMetadata({
            metadata: [{
                type: "LOGICAL_TABLE",
            }],
            record_size: 2000,
            sort_options: {
                field_name: "LAST_ACCESSED",
                order: "DESC",
            }
        });
        
        const results = resp
            .filter(d => d.metadata_header.type === "WORKSHEET")
            .map(d => ({
                name: d.metadata_header.name,
                id: d.metadata_header.id,
                description: d.metadata_header.description,
            }));
            
        span?.setAttribute("data_sources_count", results.length);
        
        return results;
    }

    /**
     * Get session information
     */
    @WithSpan('get-session-info')
    async getSessionInfo(): Promise<SessionInfo> {
        const span = trace.getSpan(context.active());
        
        const info = await (this.client as any).getSessionInfo();
        const devMixpanelToken = info.configInfo.mixpanelConfig.devSdkKey;
        const prodMixpanelToken = info.configInfo.mixpanelConfig.prodSdkKey;
        const mixpanelToken = info.configInfo.mixpanelConfig.production
            ? prodMixpanelToken
            : devMixpanelToken;
            
        span?.setAttribute("user_guid", info.userGUID);
        span?.setAttribute("user_name", info.userName);
        span?.setAttribute("cluster_name", info.configInfo.selfClusterName);
        span?.setAttribute("release_version", info.releaseVersion);
        
        return {
            mixpanelToken,
            userGUID: info.userGUID,
            userName: info.userName,
            clusterName: info.configInfo.selfClusterName,
            clusterId: info.configInfo.selfClusterId,
            releaseVersion: info.releaseVersion,
            currentOrgId: info.currentOrgId,
            privileges: info.privileges,
        };
    }

    /**
     * Search worksheets by term
     */
    @WithSpan('search-worksheets')
    async searchWorksheets(searchTerm: string): Promise<DataSource[]> {
        const span = trace.getSpan(context.active());
        
        span?.setAttribute('search_term', searchTerm);
        span?.setAttribute('search_type', 'worksheets');

        const resp = await this.client.searchMetadata({
            metadata: [{
                type: "LOGICAL_TABLE",
            }],
            record_size: 100,
            sort_options: {
                field_name: "NAME",
                order: "ASC",
            }
        });

        const results = resp
            .filter(d => d.metadata_header.type === "WORKSHEET")
            .filter(d => d.metadata_header.name.toLowerCase().includes(searchTerm.toLowerCase()))
            .map(d => ({
                name: d.metadata_header.name,
                id: d.metadata_header.id,
                description: d.metadata_header.description,
            }));

        span?.setAttribute('results_count', results.length);
        
        return results;
    }

    /**
     * Validate connection to ThoughtSpot
     */
    @WithSpan('validate-connection')
    async validateConnection(): Promise<boolean> {
        try {
            await (this.client as any).getSessionInfo();
            return true;
        } catch (error) {
            // The decorator will automatically record the exception
            return false;
        }
    }
}

// Backward compatibility - export functions that use the service class
export async function getRelevantQuestions(
    query: string,
    sourceIds: string[],
    additionalContext: string,
    client: ThoughtSpotRestApi,
): Promise<{ questions: { question: string, datasourceId: string }[], error: Error | null }> {
    const service = new ThoughtSpotService(client);
    return service.getRelevantQuestions(query, sourceIds, additionalContext);
}

export async function getAnswerForQuestion(
    question: string,
    sourceId: string,
    shouldGetTML: boolean,
    client: ThoughtSpotRestApi,
) {
    const service = new ThoughtSpotService(client);
    return service.getAnswerForQuestion(question, sourceId, shouldGetTML);
}

export async function fetchTMLAndCreateLiveboard(
    name: string,
    answers: any[],
    client: ThoughtSpotRestApi,
) {
    const service = new ThoughtSpotService(client);
    return service.fetchTMLAndCreateLiveboard(name, answers);
}

export async function createLiveboard(
    name: string,
    answers: any[],
    client: ThoughtSpotRestApi,
) {
    const service = new ThoughtSpotService(client);
    return service.createLiveboard(name, answers);
}

export async function getDataSources(
    client: ThoughtSpotRestApi,
): Promise<DataSource[]> {
    const service = new ThoughtSpotService(client);
    return service.getDataSources();
}

export async function getSessionInfo(client: ThoughtSpotRestApi): Promise<SessionInfo> {
    const service = new ThoughtSpotService(client);
    return service.getSessionInfo();
}

/**
 * Usage examples:
 * 
 * // Create service instance
 * const service = new ThoughtSpotService(client);
 * 
 * // All method calls are automatically traced with meaningful span names
 * const questions = await service.getRelevantQuestions('sales data', ['ws1', 'ws2'], 'context');
 * const answer = await service.getAnswerForQuestion('What is total sales?', 'ws1', true);
 * const dataSources = await service.getDataSources();
 * const sessionInfo = await service.getSessionInfo();
 * const worksheets = await service.searchWorksheets('sales');
 * const isConnected = await service.validateConnection();
 * 
 * // Creating liveboards
 * const liveboard = await service.createLiveboard('My Dashboard', answers);
 * const liveboardResult = await service.fetchTMLAndCreateLiveboard('My Dashboard', answers);
 */
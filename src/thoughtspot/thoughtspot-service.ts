import type { ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk";

export async function getRelevantQuestions(
    query: string,
    sourceIds: string[],
    additionalContext: string,
    client: ThoughtSpotRestApi): Promise<{ questions: { question: string, datasourceId: string }[], error: Error | null }> {
    try {
        additionalContext = additionalContext || '';
        const resp = await client.queryGetDecomposedQuery({
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
        return {
            questions,
            error: null,
        }
    } catch (error) {
        console.error("Error getting relevant questions: ", error, "sourceIds: ", sourceIds, "instanceUrl: ", (client as any).instanceUrl);
        return {
            questions: [],
            error: error as Error,
        }
    }
}

async function getAnswerData({ question, session_identifier, generation_number, client }: { question: string, session_identifier: string, generation_number: number, client: ThoughtSpotRestApi }) {
    try {
        console.log("[DEBUG] Getting Data for question: ", question, "instanceUrl: ", (client as any).instanceUrl);
        // Proxy to avoid 403 from TS AWS WAF.
        const data = await client.exportAnswerReport({
            session_identifier,
            generation_number,
            file_format: "CSV",
        })
        let csvData = await data.text();
        // get only the first 100 lines of the csv data
        csvData = csvData.split('\n').slice(0, 100).join('\n');
        return csvData;
    } catch (error) {
        console.error("Error getting answer Data: ", error, "instanceUrl: ", (client as any).instanceUrl);
        throw error;
    }
}

async function getAnswerTML({ question, session_identifier, generation_number, client }: { question: string, session_identifier: string, generation_number: number, client: ThoughtSpotRestApi }) {
    try {
        console.log("[DEBUG] Getting TML for question: ", question);
        const tml = await (client as any).exportUnsavedAnswerTML({
            session_identifier,
            generation_number,
        })
        return tml;
    } catch (error) {
        console.error("Error getting answer TML: ", error);
        return null;
    }
}

export async function getAnswerForQuestion(question: string, sourceId: string, shouldGetTML: boolean, client: ThoughtSpotRestApi) {
    console.log("[DEBUG] Getting answer for question: ", question);
    try {
        const answer = await client.singleAnswer({
            query: question,
            metadata_identifier: sourceId,
        })

        const { session_identifier, generation_number } = answer as any;

        const [data, tml] = await Promise.all([
            getAnswerData({
                question,
                session_identifier,
                generation_number,
                client
            }),
            shouldGetTML
                ? getAnswerTML({
                    question,
                    session_identifier,
                    generation_number,
                    client
                })
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
        console.error("Error getting answer for question: ", question, " and sourceId: ", sourceId, " and shouldGetTML: ", shouldGetTML, " and error: ", error, "instanceUrl: ", (client as any).instanceUrl);
        return {
            error: error as Error,
        };
    }
}

export async function fetchTMLAndCreateLiveboard(name: string, answers: any[], client: ThoughtSpotRestApi) {
    try {
        const tmls = await Promise.all(answers.map((answer) => getAnswerTML({
            question: answer.question,
            session_identifier: answer.session_identifier,
            generation_number: answer.generation_number,
            client,
        })));
        answers.forEach((answer, idx) => {
            answer.tml = tmls[idx];
        });

        const liveboardUrl = await createLiveboard(name, answers, client);
        return {
            url: liveboardUrl,
            error: null,
        }
    } catch (error) {
        console.error("Error fetching TML and creating liveboard: ", error);
        return {
            liveboardUrl: null,
            error: error as Error,
        }
    }
}

export async function createLiveboard(name: string, answers: any[], client: ThoughtSpotRestApi) {
    answers = answers.filter((answer) => answer.tml);
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

    const resp = await client.importMetadataTML({
        metadata_tmls: [JSON.stringify(tml)],
        import_policy: "ALL_OR_NONE",
    })

    return `${(client as any).instanceUrl}/#/pinboard/${resp[0].response.header.id_guid}`;
}

export interface DataSource {
    name: string;
    id: string;
    description: string;
}

export async function getDataSources(client: ThoughtSpotRestApi): Promise<DataSource[]> {
    const resp = await client.searchMetadata({
        metadata: [{
            type: "LOGICAL_TABLE",
        }],
        record_size: 2000,
        sort_options: {
            field_name: "LAST_ACCESSED",
            order: "DESC",
        }
    });
    return resp
        .filter(d => d.metadata_header.type === "WORKSHEET")
        .map(d => {
            return {
                name: d.metadata_header.name,
                id: d.metadata_header.id,
                description: d.metadata_header.description,
            }
        });
}


export interface SessionInfo {
    mixpanelToken: string;
    clusterName: string;
    clusterId: string;
    userGUID: string;
    userName: string;
    releaseVersion: string;
    currentOrgId: string;
    privileges: string[];
}

export async function getSessionInfo(client: ThoughtSpotRestApi): Promise<SessionInfo> {
    const info = await (client as any).getSessionInfo();
    const devMixpanelToken = info.configInfo.mixpanelConfig.devSdkKey;
    const prodMixpanelToken = info.configInfo.mixpanelConfig.prodSdkKey;
    const mixpanelToken = info.configInfo.mixpanelConfig.production
        ? prodMixpanelToken
        : devMixpanelToken;
    return {
        mixpanelToken,
        userGUID: info.userGUID,
        userName: info.userName,
        clusterName: info.configInfo.selfClusterName,
        clusterId: info.configInfo.selfClusterId,
        releaseVersion: info.releaseVersion,
        currentOrgId: info.currentOrgId,
        privileges: info.privileges,
    }
}
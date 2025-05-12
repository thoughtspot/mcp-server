import { ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk";

export async function getRelevantQuestions(query: string, sourceId: string, additionalContext: string = '', client: ThoughtSpotRestApi): Promise<string[]> {
    const questions = await client.queryGetDecomposedQuery({
        nlsRequest: {
            query: query,
        },
        content: [
            additionalContext,
        ],
        worksheetIds: [sourceId]
    })
    return questions.decomposedQueryResponse?.decomposedQueries?.map((q) => q.query!) || [];
}

async function getAnswerData({ question, session_identifier, generation_number, client }: { question: string, session_identifier: string, generation_number: number, client: ThoughtSpotRestApi }) {
    try {
        console.log("[DEBUG] Getting Data for question: ", question);
        // Proxy to avoid 403 from TS AWS WAF.
        const data = await (client as any).exportAnswerReportProxied({
            session_identifier,
            generation_number,
            file_format: "CSV",
        })
        let csvData = await data.text();
        // get only the first 100 lines of the csv data
        csvData = csvData.split('\n').slice(0, 100).join('\n');
        return csvData;
    } catch (error) {
        console.error("Error getting answer Data: ", error);
        return null;
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
    };
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
        record_size: 1000,
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

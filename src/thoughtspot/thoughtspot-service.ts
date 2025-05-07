import { ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk";

const DATA_SOURCE_ID = "cd252e5c-b552-49a8-821d-3eadaa049cca";


export async function getRelevantQuestions(query: string, additionalContext: string = '', client: ThoughtSpotRestApi): Promise<string[]> {
    const questions = await client.queryGetDecomposedQuery({
        nlsRequest: {
            query: query,
        },
        content: [
            additionalContext,
        ],
        worksheetIds: [DATA_SOURCE_ID]
    })
    return questions.decomposedQueryResponse?.decomposedQueries?.map((q) => q.query!) || [];
}

export async function getAnswerForQuestion(question: string, shouldGetTML: boolean, client: ThoughtSpotRestApi) {
    console.log("[DEBUG] Getting answer for question: ", question);
    const answer = await client.singleAnswer({
        query: question,
        metadata_identifier: DATA_SOURCE_ID,
    })

    console.log("[DEBUG] Getting Data for question: ", question);
    const [data, tml] = await Promise.all([
        client.exportAnswerReport({
            session_identifier: answer.session_identifier!,
            generation_number: answer.generation_number!,
            file_format: "CSV",
        }),
        shouldGetTML ? (client as any).exportUnsavedAnswerTML({
            session_identifier: answer.session_identifier!,
            generation_number: answer.generation_number!,
        }) : Promise.resolve(null)
    ])

    let csvData = await data.text();
    // get only the first 100 lines of the csv data
    csvData = csvData.split('\n').slice(0, 100).join('\n');

    return {
        question,
        ...answer,
        data: csvData,
        tml,
    };
}

export async function createLiveboard(name: string, answers: any[], client: ThoughtSpotRestApi) {
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


import { createLiveboard, getAnswerForQuestion, getRelevantQuestions } from "./thoughtspot-service";
import { ThoughtSpotRestApi } from "@thoughtspot/rest-api-sdk";

const DEFAULT_DATA_SOURCE_ID = "cd252e5c-b552-49a8-821d-3eadaa049cca";
const DO_ADDITIONAL_QUESTIONS = false;


async function getAnswersForQuestions(questions: string[], sourceId: string, shouldGetTML: boolean, notify: (data: string) => void, client: ThoughtSpotRestApi) {
    const answers = (await Promise.all(
        questions.map(async (question) => {
            try {
                return await getAnswerForQuestion(question, sourceId, shouldGetTML, client);
            } catch (error) {
                console.error(`Failed to get answer for question: ${question}`, error);
                return null;
            }
        })
    )).filter((answer): answer is NonNullable<typeof answer> => answer !== null);

    notify(`\n\nRetrieved ${answers.length} answers using **ThoughtSpot Spotter**\n\n`);
    return answers;
}



export const getRelevantData = async ({
    query,
    sourceId,
    shouldCreateLiveboard,
    notify,
    client,
}: {
    query: string;
    sourceId?: string;
    shouldCreateLiveboard: boolean;
    notify: (data: string) => void;
    client: ThoughtSpotRestApi;
}) => {
    sourceId = sourceId || DEFAULT_DATA_SOURCE_ID;
    const questions = await getRelevantQuestions(query, sourceId, "", client);
    notify(`#### Retrieving answers to these relevant questions:\n ${questions.map((q) => `- ${q}`).join("\n")}`);

    let answers = await getAnswersForQuestions(questions, sourceId, shouldCreateLiveboard, notify, client);

    if (DO_ADDITIONAL_QUESTIONS) {
        const additionalQuestions = await getRelevantQuestions(query, sourceId, `
            These questions have been answered already (with their csv data): ${answers.map((a) => `Question: ${a.question} \n CSV data: \n${a.data}`).join("\n\n ")}
        Look at the csv data of the above queries to see if you need additional related queries to be answered. You can also ask questions going deeper into the data returned by applying filters.
        Do NOT resend the same query already asked before.
    `, client);
        notify(`#### Need to get answers to some of these additional questions:\n ${additionalQuestions.map((q) => `- ${q}`).join("\n")}`);

        const additionalAnswers = await getAnswersForQuestions(additionalQuestions, sourceId, shouldCreateLiveboard, notify, client);

        answers = [...answers, ...additionalAnswers];
    }

    const liveboard = shouldCreateLiveboard ? await createLiveboard(query, answers, client) : null;
    return {
        allAnswers: answers,
        liveboard,
    };
};
import { Hono } from 'hono'
import type { Props } from '../utils';
import {
    createLiveboard,
    getAnswerForQuestion,
    getDataSources,
    getRelevantQuestions
} from '../thoughtspot/thoughtspot-service';
import { getThoughtSpotClient } from '../thoughtspot/thoughtspot-client';
import { GetRelevantQuestionsSchema, GetAnswerSchema, CreateLiveboardSchema } from '../api-schemas/schemas';

const apiServer = new Hono<{ Bindings: Env & { props: Props } }>()

apiServer.get("/api/tools/ping", async (c) => {
    const { props } = c.executionCtx;
    console.log("Received Ping request");
    if (props.accessToken && props.instanceUrl) {
        return c.json({
            content: [{ type: "text", text: "Pong" }],
        });
    } else {
        return c.json({
            isError: true,
            content: [{ type: "text", text: "ERROR: Not authenticated" }],
        });
    }
});

apiServer.post("/api/tools/relevant-questions", async (c) => {
    const { props } = c.executionCtx;
    const body = await c.req.json();
    const validatedData = GetRelevantQuestionsSchema.parse(body);
    const { query, datasourceIds, additionalContext } = validatedData;
    const client = getThoughtSpotClient(props.instanceUrl, props.accessToken);
    const questions = await getRelevantQuestions(query, datasourceIds || [], additionalContext || '', client);
    return c.json(questions);
});

apiServer.post("/api/tools/get-answer", async (c) => {
    const { props } = c.executionCtx;
    const body = await c.req.json();
    const validatedData = GetAnswerSchema.parse(body);
    const { question, datasourceId } = validatedData;
    const client = getThoughtSpotClient(props.instanceUrl, props.accessToken);
    const answer = await getAnswerForQuestion(question, datasourceId, false, client);
    return c.json(answer);
});

apiServer.post("/api/tools/create-liveboard", async (c) => {
    const { props } = c.executionCtx;
    const body = await c.req.json();
    const validatedData = CreateLiveboardSchema.parse(body);
    const { name, answers } = validatedData;
    const client = getThoughtSpotClient(props.instanceUrl, props.accessToken);
    const liveboardUrl = await createLiveboard(name, answers, client);
    return c.text(liveboardUrl);
});

apiServer.get("/api/resources/datasources", async (c) => {
    const { props } = c.executionCtx;
    const client = getThoughtSpotClient(props.instanceUrl, props.accessToken);
    const datasources = await getDataSources(client);
    return c.json(datasources);
});

apiServer.post("/api/rest/2.0/*", async (c) => {
    const { props } = c.executionCtx;
    const path = c.req.path;
    const method = c.req.method;
    const body = await c.req.json();
    return fetch(props.instanceUrl + path, {
        method,
        headers: {
            "Authorization": `Bearer ${props.accessToken}`,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "ThoughtSpot-ts-client",
        },
        body: JSON.stringify(body),
    });
});

apiServer.get("/api/rest/2.0/*", async (c) => {
    const { props } = c.executionCtx;
    const path = c.req.path;
    const method = c.req.method;
    return fetch(props.instanceUrl + path, {
        method,
        headers: {
            "Authorization": `Bearer ${props.accessToken}`,
            "Accept": "application/json",
            "User-Agent": "ThoughtSpot-ts-client",
        }
    });
});

export {
    apiServer,
}
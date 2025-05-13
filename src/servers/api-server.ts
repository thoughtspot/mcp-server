import { Hono } from 'hono'
import { Props } from '../utils';
import { createLiveboard, getAnswerForQuestion, getDataSources, getRelevantQuestions } from '../thoughtspot/thoughtspot-service';
import { getThoughtSpotClient } from '../thoughtspot/thoughtspot-client';

const apiServer = new Hono<{ Bindings: Env & { props: Props } }>()

apiServer.post("/api/tools/relevant-questions", async (c) => {
    const { props } = c.executionCtx;
    const { query, datasourceId, additionalContext } = await c.req.json();
    const client = getThoughtSpotClient(props.instanceUrl, props.accessToken);
    const questions = await getRelevantQuestions(query, datasourceId, additionalContext || '', client);
    return c.json(questions);
});

apiServer.post("/api/tools/get-answer", async (c) => {
    const { props } = c.executionCtx;
    const { question, datasourceId } = await c.req.json();
    const client = getThoughtSpotClient(props.instanceUrl, props.accessToken);
    const answer = await getAnswerForQuestion(question, datasourceId, false, client);
    return c.json(answer);
});

apiServer.post("/api/tools/create-liveboard", async (c) => {
    const { props } = c.executionCtx;
    const { name, answers } = await c.req.json();
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
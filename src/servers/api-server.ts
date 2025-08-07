import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { Props } from '../utils';
import { McpServerError } from '../utils';
import { getDataSources, ThoughtSpotService } from '../thoughtspot/thoughtspot-service';
import { getThoughtSpotClient } from '../thoughtspot/thoughtspot-client';
import { getActiveSpan, WithSpan } from '../metrics/tracing/tracing-utils';
<<<<<<< HEAD
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { CreateLiveboardSchema, GetAnswerSchema, GetRelevantQuestionsSchema } from '../api-schemas/schemas';
=======
import { CreateLiveboardSchema, GetAnswerSchema, GetRelevantQuestionsSchema } from './mcp-server';
>>>>>>> 33eca26 (address comments -  export tool schemas from respective servers)

const apiServer = new Hono<{ Bindings: Env & { props: Props } }>()

class ApiHandler {

    private initSpan(props: Props) {
        const span = getActiveSpan();
        span?.setAttributes({
            instance_url: props.instanceUrl,
        });
    }

    private getThoughtSpotService(props: Props): ThoughtSpotService {
        this.initSpan(props);
        return new ThoughtSpotService(getThoughtSpotClient(props.instanceUrl, props.accessToken));
    }

    @WithSpan('api-relevant-questions')
    async getRelevantQuestions(props: Props, query: string, datasourceIds: string[], additionalContext?: string) {
        const service = this.getThoughtSpotService(props);
        return await service.getRelevantQuestions(query, datasourceIds, additionalContext || '');
    }

    @WithSpan('api-get-answer')
    async getAnswer(props: Props, question: string, datasourceId: string) {
        const service = this.getThoughtSpotService(props);
        return await service.getAnswerForQuestion(question, datasourceId, false);
    }

    @WithSpan('api-create-liveboard')
    async createLiveboard(props: Props, name: string, answers: any[], noteTileParsedHtml: string) {
        const service = this.getThoughtSpotService(props);
        const result = await service.fetchTMLAndCreateLiveboard(name, answers, noteTileParsedHtml);
        return result.url || '';
    }

    @WithSpan('api-get-datasources')
    async getDataSources(props: Props) {
        const service = this.getThoughtSpotService(props);
        return await service.getDataSources();
    }

    @WithSpan('api-proxy-post')
    async proxyPost(props: Props, path: string, body: any) {
        const span = getActiveSpan();
        span?.setAttributes({
            instance_url: props.instanceUrl,
            path: path,
        });
        span?.addEvent("proxy-post");
        return fetch(props.instanceUrl + path, {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${props.accessToken}`,
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "ThoughtSpot-ts-client",
            },
            body: JSON.stringify(body),
        });
    }

    @WithSpan('api-proxy-get')
    async proxyGet(props: Props, path: string) {
        const span = getActiveSpan();
        span?.setAttributes({
            instance_url: props.instanceUrl,
            path: path,
        });
        span?.addEvent("proxy-get");
        return fetch(props.instanceUrl + path, {
            method: 'GET',
            headers: {
                "Authorization": `Bearer ${props.accessToken}`,
                "Accept": "application/json",
                "User-Agent": "ThoughtSpot-ts-client",
            }
        });
    }
}

const handler = new ApiHandler();

apiServer.post(
    "/api/tools/relevant-questions",
    zValidator('json', GetRelevantQuestionsSchema),
    async (c) => {
        const { props } = c.executionCtx;
        const { query, datasourceIds, additionalContext } = c.req.valid('json');
        const questions = await handler.getRelevantQuestions(props, query, datasourceIds, additionalContext);
        return c.json(questions);
    }
);

apiServer.post(
    "/api/tools/get-answer",
    zValidator('json', GetAnswerSchema),
    async (c) => {
        const { props } = c.executionCtx;
        const { question, datasourceId } = c.req.valid('json');
        const answer = await handler.getAnswer(props, question, datasourceId);
        return c.json(answer);
    }
);

apiServer.post(
    "/api/tools/create-liveboard",
    zValidator('json', CreateLiveboardSchema),
    async (c) => {
        const { props } = c.executionCtx;
        const { name, answers, noteTile } = c.req.valid('json');
        const liveboardUrl = await handler.createLiveboard(props, name, answers, noteTile);
        return c.text(liveboardUrl);
    }
);

apiServer.get("/api/tools/ping", async (c) => {
    const { props } = c.executionCtx;
    console.log("Received Ping request");
    if (props.accessToken && props.instanceUrl) {
        return c.json({
            content: [{ type: "text", text: "Pong" }],
        });
    }
    return c.json({
        isError: true,
        content: [{ type: "text", text: "ERROR: Not authenticated" }],
    });
});

apiServer.get("/api/resources/datasources", async (c) => {
    const { props } = c.executionCtx;
    const datasources = await handler.getDataSources(props);
    return c.json(datasources);
});

apiServer.post("/api/rest/2.0/*", async (c) => {
    const { props } = c.executionCtx;
    const path = c.req.path;
    const method = c.req.method;
    const body = await c.req.json();
    return handler.proxyPost(props, path, body);
});

apiServer.get("/api/rest/2.0/*", async (c) => {
    const { props } = c.executionCtx;
    const path = c.req.path;
    return handler.proxyGet(props, path);
});

export {
    apiServer,
}
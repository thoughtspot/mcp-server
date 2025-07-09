import { Hono } from 'hono'
import type { Props } from '../utils';
import { getDataSources, ThoughtSpotService } from '../thoughtspot/thoughtspot-service';
import { getThoughtSpotClient } from '../thoughtspot/thoughtspot-client';
import { WithSpan } from '../metrics/tracing/tracing-utils';
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const apiServer = new Hono<{ Bindings: Env & { props: Props } }>()

class ApiHandler {
    private getThoughtSpotService(props: Props): ThoughtSpotService {
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
    async createLiveboard(props: Props, name: string, answers: any[]) {
        const service = this.getThoughtSpotService(props);
        const result = await service.fetchTMLAndCreateLiveboard(name, answers);
        return result.url || '';
    }

    @WithSpan('api-get-datasources')
    async getDataSources(props: Props) {
        const service = this.getThoughtSpotService(props);
        return await service.getDataSources();
    }

    @WithSpan('api-proxy-post')
    async proxyPost(props: Props, path: string, body: any) {
        const span = trace.getSpan(context.active());
        span?.setAttribute("instance_url", props.instanceUrl);
        span?.setAttribute("path", path);
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
        const span = trace.getSpan(context.active());
        span?.setAttribute("instance_url", props.instanceUrl);
        span?.setAttribute("path", path);
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

apiServer.post("/api/tools/relevant-questions", async (c) => {
    const { props } = c.executionCtx;
    const { query, datasourceIds, additionalContext } = await c.req.json();
    const questions = await handler.getRelevantQuestions(props, query, datasourceIds, additionalContext);
    return c.json(questions);
});

apiServer.post("/api/tools/get-answer", async (c) => {
    const { props } = c.executionCtx;
    const { question, datasourceId } = await c.req.json();
    const answer = await handler.getAnswer(props, question, datasourceId);
    return c.json(answer);
});

apiServer.post("/api/tools/create-liveboard", async (c) => {
    const { props } = c.executionCtx;
    const { name, answers } = await c.req.json();
    const liveboardUrl = await handler.createLiveboard(props, name, answers);
    return c.text(liveboardUrl);
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
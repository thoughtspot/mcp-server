import { Hono } from 'hono'
import { Props } from './utils';
import {
    createLiveboard,
    getAnswerForQuestion,
    getDataSources,
    getRelevantQuestions
} from './thoughtspot/thoughtspot-service';
import { getThoughtSpotClient } from './thoughtspot/thoughtspot-client';

export const apiServer = new Hono<{ Bindings: Env & { props: Props } }>()

apiServer.post("/ping/test/abc", async (c) => {
    const { props } = c.executionCtx;

    console.log("Received Ping request");
    if (props.accessToken && props.instanceUrl) {
        return {
            content: [{ type: "text", text: "Pong" }],
        };
    } else {
        return {
            isError: true,
            content: [{ type: "text", text: "ERROR: Not authenticated" }],
        };
    }
});

// Add a simple root route for now
apiServer.get('/', (c) => {
  return c.json({ message: 'API Server is running' });
});
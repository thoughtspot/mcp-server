import type {
    AgentExecutor,
    RequestContext,
    ExecutionEventBus,
  } from "@a2a-js/sdk/server";
  import { ThoughtSpotService } from "../thoughtspot/thoughtspot-service";
  import { getThoughtSpotClient } from "../thoughtspot/thoughtspot-client";
  import type { Props } from "../utils";
  import { thoughtSpotAgentCard } from './agent-card';
  import { DefaultRequestHandler, InMemoryTaskStore, type TaskStore } from '@a2a-js/sdk/server';
  import { JsonRpcTransportHandler } from '@a2a-js/sdk/server';
  import type { JSONRPCSuccessResponse } from '@a2a-js/sdk';
  
  // 1. Define your agent's logic as a AgentExecutor
  export class MyAgentExecutor implements AgentExecutor {
    private cancelledTasks = new Set<string>();
    private thoughtSpotProps: Props | null = null;
  
    // Method to set ThoughtSpot context from outside
    public setThoughtSpotContext(props: Props): void {
      this.thoughtSpotProps = props;
    }
  
    public cancelTask = async (
      taskId: string,
      eventBus: ExecutionEventBus
    ): Promise<void> => {
      this.cancelledTasks.add(taskId);
      // The execute loop is responsible for publishing the final state
    };
  
    private getThoughtSpotService(props: Props): ThoughtSpotService {
      return new ThoughtSpotService(getThoughtSpotClient(props.instanceUrl, props.accessToken));
    }

    private generateUuid(): string {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    private isPingRequest(userMessage: string): boolean {
      const message = userMessage.toLowerCase().trim();
      return message === 'ping' || 
             message.includes('test connection') || 
             message.includes('check authentication') || 
             message.includes('am i authenticated') ||
             message.includes('test auth');
    }

    private async handlePingRequest(taskId: string, contextId: string, eventBus: ExecutionEventBus): Promise<void> {
      let pingResult: string;
      let authStatus: string;
      
      if (this.thoughtSpotProps?.accessToken && this.thoughtSpotProps?.instanceUrl) {
        try {
          // Try to make an authenticated call to verify connection
          const thoughtSpotService = this.getThoughtSpotService(this.thoughtSpotProps);
          const sessionInfo = await thoughtSpotService.getSessionInfo();
          
          authStatus = "✅ Authenticated";
          pingResult = `Pong! 🏓

Authentication Status: ${authStatus}
ThoughtSpot Instance: ${this.thoughtSpotProps.instanceUrl}
Connected User: ${sessionInfo?.userName || 'Unknown'}
User GUID: ${sessionInfo?.userGUID || 'N/A'}
Cluster: ${sessionInfo?.clusterName || 'N/A'}

Connection test successful!`;
        } catch (error) {
          authStatus = "❌ Authentication Failed";
          pingResult = `Pong! 🏓

Authentication Status: ${authStatus}
ThoughtSpot Instance: ${this.thoughtSpotProps.instanceUrl}
Error: ${error instanceof Error ? error.message : 'Unknown error'}

Connection test failed!`;
        }
      } else {
        authStatus = "❌ Not Authenticated";
        pingResult = `Pong! 🏓

Authentication Status: ${authStatus}
ThoughtSpot Instance: Not configured
Error: Missing ThoughtSpot credentials

Please ensure you are properly authenticated through OAuth.`;
      }

      // Publish working status
      const workingStatusUpdate = {
        kind: "status-update" as const,
        taskId: taskId,
        contextId: contextId,
        status: {
          state: "working" as const,
          message: {
            kind: "message" as const,
            role: "agent" as const,
            messageId: this.generateUuid(),
            parts: [{ kind: "text" as const, text: "Testing authentication..." }],
            taskId: taskId,
            contextId: contextId,
          },
          timestamp: new Date().toISOString(),
        },
        final: false,
      };
      eventBus.publish(workingStatusUpdate);

      // Small delay to simulate processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Publish artifact with ping result
      const artifactUpdate = {
        kind: "artifact-update" as const,
        taskId: taskId,
        contextId: contextId,
        artifact: {
          artifactId: "ping-result",
          name: "Ping Test Result",
          parts: [{ kind: "text" as const, text: pingResult }],
        },
        append: false,
        lastChunk: true,
      };
      eventBus.publish(artifactUpdate);

      // Publish final status
      const finalUpdate = {
        kind: "status-update" as const,
        taskId: taskId,
        contextId: contextId,
        status: {
          state: "completed" as const,
          message: {
            kind: "message" as const,
            role: "agent" as const,
            messageId: this.generateUuid(),
            parts: [{ kind: "text" as const, text: "Ping test completed!" }],
            taskId: taskId,
            contextId: contextId,
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      };
      eventBus.publish(finalUpdate);
      eventBus.finished();
    }

    async execute(
      requestContext: RequestContext,
      eventBus: ExecutionEventBus
    ): Promise<void> {
      const userMessage = requestContext.userMessage;
      const existingTask = requestContext.task;
  
      // Determine IDs for the task and context, from requestContext.
      const taskId = requestContext.taskId;
      const contextId = requestContext.contextId;

      // Extract the text content from the user message
      const userText = userMessage.parts
        ?.filter(part => part.kind === 'text')
        ?.map(part => (part as any).text)
        ?.join(' ') || '';
  
      console.log(
        `[MyAgentExecutor] Processing message ${userMessage.messageId} for task ${taskId} (context: ${contextId})`
      );
        // Check if this is a ping request
        if (this.isPingRequest(userText)) {
            console.log(`[MyAgentExecutor] Handling ping request for task ${taskId}`);
            
            // Publish initial task if needed
            if (!existingTask) {
                const initialTask = {
                    kind: "task" as const,
                    id: taskId,
                    contextId: contextId,
                    status: {
                        state: "submitted" as const,
                        timestamp: new Date().toISOString(),
                    },
                    history: [userMessage],
                    metadata: userMessage.metadata,
                    artifacts: [],
                };
                eventBus.publish(initialTask);
            }

            await this.handlePingRequest(taskId, contextId, eventBus);
            return;
        }
  
      // Check if we have ThoughtSpot authentication
      let thoughtSpotService: ThoughtSpotService | null = null;
      if (this.thoughtSpotProps?.accessToken && this.thoughtSpotProps?.instanceUrl) {
        thoughtSpotService = this.getThoughtSpotService(this.thoughtSpotProps);
        console.log(`[MyAgentExecutor] ThoughtSpot service initialized for ${this.thoughtSpotProps.instanceUrl}`);
      }
  
      // 1. Publish initial Task event if it's a new task
      if (!existingTask) {
        const initialTask = {
          kind: "task" as const,
          id: taskId,
          contextId: contextId,
          status: {
            state: "submitted" as const,
            timestamp: new Date().toISOString(),
          },
          history: [userMessage],
          metadata: userMessage.metadata,
          artifacts: [], // Initialize artifacts array
        };
        eventBus.publish(initialTask);
      }
  
      // 2. Publish "working" status update
      const workingStatusUpdate = {
        kind: "status-update" as const,
        taskId: taskId,
        contextId: contextId,
        status: {
          state: "working" as const,
          message: {
            kind: "message" as const,
            role: "agent" as const,
            messageId: this.generateUuid(),
            parts: [{ kind: "text" as const, text: thoughtSpotService ? "Processing your request with ThoughtSpot..." : "Processing your request..." }],
            taskId: taskId,
            contextId: contextId,
          },
          timestamp: new Date().toISOString(),
        },
        final: false,
      };
      eventBus.publish(workingStatusUpdate);
  
      // Simulate work...
      await new Promise((resolve) => setTimeout(resolve, 1000));
  
      // Check for request cancellation
      if (this.cancelledTasks.has(taskId)) {
        console.log(`[MyAgentExecutor] Request cancelled for task: ${taskId}`);
        const cancelledUpdate = {
          kind: "status-update" as const,
          taskId: taskId,
          contextId: contextId,
          status: {
            state: "canceled" as const,
            timestamp: new Date().toISOString(),
          },
          final: true,
        };
        eventBus.publish(cancelledUpdate);
        eventBus.finished();
        return;
      }
  
      // Process the request - if we have ThoughtSpot service, use it
      let responseText = `Task ${taskId} completed.`;
      if (thoughtSpotService) {
        try {
          // Example: Get session info to demonstrate ThoughtSpot integration
          const sessionInfo = await thoughtSpotService.getSessionInfo();
          responseText = `Task ${taskId} completed with ThoughtSpot integration. Connected to ${this.thoughtSpotProps?.instanceUrl} as user: ${sessionInfo?.userName || 'Unknown'}`;
        } catch (error) {
          console.error('Error accessing ThoughtSpot:', error);
          responseText = `Task ${taskId} completed, but encountered an error accessing ThoughtSpot: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      }
  
      // 3. Publish artifact update
      const artifactUpdate = {
        kind: "artifact-update" as const,
        taskId: taskId,
        contextId: contextId,
        artifact: {
          artifactId: "artifact-1",
          name: "artifact-1",
          parts: [{ kind: "text" as const, text: responseText }],
        },
        append: false, // Each emission is a complete file snapshot
        lastChunk: true, // True for this file artifact
      };
      eventBus.publish(artifactUpdate);
  
      // 4. Publish final status update
      const finalUpdate = {
        kind: "status-update" as const,
        taskId: taskId,
        contextId: contextId,
        status: {
          state: "completed" as const,
          message: {
            kind: "message" as const,
            role: "agent" as const,
            messageId: this.generateUuid(),
            parts: [{ kind: "text" as const, text: "Task completed successfully!" }],
            taskId: taskId,
            contextId: contextId,
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      };
      eventBus.publish(finalUpdate);
      eventBus.finished();
    }
  }

  const taskStore: TaskStore = new InMemoryTaskStore();
  const agentExecutor: AgentExecutor = new MyAgentExecutor();
  
  const basicRequestHandler = new DefaultRequestHandler(
      thoughtSpotAgentCard,
      taskStore,
      agentExecutor
    );
  
  async function handleA2ARequest(req: Request, env: Env, ctx: ExecutionContext) {
      (agentExecutor as MyAgentExecutor).setThoughtSpotContext(ctx.props as Props);
  
      const jsonHandler = new JsonRpcTransportHandler(basicRequestHandler);
      const requestBody = await req.json();
      try {
          const rpcResponseOrStream = await jsonHandler.handle(requestBody);
  
          if (typeof (rpcResponseOrStream as any)?.[Symbol.asyncIterator] === 'function') {
              const stream = new ReadableStream({
                  async start(controller) {
                    try {
                      for await (const event of rpcResponseOrStream as AsyncGenerator<JSONRPCSuccessResponse, void, undefined>) {
                        const sseData = `id: ${new Date().getTime()}\ndata: ${JSON.stringify(event)}\n\n`;
                        controller.enqueue(new TextEncoder().encode(sseData));
                      }
                      controller.close();
                    } catch (error) {
                      // Handle errors by enqueueing error event and closing
                      const errorEvent = `id: ${new Date().getTime()}\nevent: error\ndata: ${JSON.stringify(error)}\n\n`;
                      controller.enqueue(new TextEncoder().encode(errorEvent));
                      controller.close();
                    }
                  }
                });
                
                return new Response(stream, {
                  headers: {
                    'Content-Type': 'text/event-stream',
                  }
                });
              }
      } catch (error) {
          console.error('Error in A2A handler:', error);
          return new Response('Internal Server Error', { status: 500, headers: {
            'Content-Type': 'text/event-stream',
          }
          });
      }
  }
  
  export const a2aHandler = {
      async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
          return await handleA2ARequest(request, env, ctx) as Response;
      }
  }
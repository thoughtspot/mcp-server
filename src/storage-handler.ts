import { DurableObject } from "cloudflare:workers";

type Message = {
	id: string;
	content: string;
	timestamp: number;
};

/**
 * StorageHandler is a Durable Object that backs the /storage route.
 * Routes are matched on the URL pathname after /storage, e.g.:
 *   POST /storage/putMessage
 *   GET  /storage/readLatest
 */
export class StorageHandler extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Strip /storage/<userGuid> prefix to get the sub-path
		const subPath = url.pathname.replace(/^\/storage\/[^\/]+/, "") || "/";

		switch (subPath) {
			case "/putMessage":
				return this.handlePutMessage(request);
			case "/readLatest":
				return this.handleReadLatest();
			default:
				return new Response(
					JSON.stringify({ error: `Unknown route: ${subPath}` }),
					{ status: 404, headers: { "Content-Type": "application/json" } },
				);
		}
	}

	/**
	 * POST /storage/putMessage
	 * Body: { id: string; content: string }
	 */
	private async handlePutMessage(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		let body: { id: string; content: string };
		try {
			body = await request.json();
		} catch {
			return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		const { id, content } = body;
		if (!id || !content) {
			return new Response(
				JSON.stringify({ error: "Missing id or content in body" }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}

		const message: Message = { id, content, timestamp: Date.now() };
		await this.ctx.storage.put(`message:${id}`, message);
		await this.ctx.storage.put("latest", id);

		return new Response(JSON.stringify(message), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	/**
	 * GET /storage/readLatest
	 * Returns the most recently stored message.
	 */
	private async handleReadLatest(): Promise<Response> {
		const latestId = await this.ctx.storage.get<string>("latest");
		if (!latestId) {
			return new Response(JSON.stringify({ error: "No messages stored" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		const message = await this.ctx.storage.get<Message>(`message:${latestId}`);
		if (!message) {
			return new Response(JSON.stringify({ error: "Message not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response(JSON.stringify(message), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}
}

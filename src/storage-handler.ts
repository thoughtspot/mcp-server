import { DurableObject } from "cloudflare:workers";

/**
 * StorageHandler is a Durable Object that backs the /storage route.
 * Each instance is keyed by a user GUID, providing isolated storage per user.
 *
 * Routes (sub-path after /storage/<userGuid>):
 *   GET  /get?key=<key>          → { value: T | null }
 *   POST /put                    → body: { key, value } → 200
 *   POST /delete                 → body: { keys: string[] } → { deleted: number }
 */
export class StorageHandler extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Strip /storage/<userGuid> prefix to get the sub-path
		const subPath = url.pathname.replace(/^\/storage\/[^\/]+/, "") || "/";

		switch (subPath) {
			case "/get":
				return this.handleGet(url);
			case "/put":
				return this.handlePut(request);
			case "/delete":
				return this.handleDelete(request);
			default:
				return new Response(
					JSON.stringify({ error: `Unknown route: ${subPath}` }),
					{ status: 404, headers: { "Content-Type": "application/json" } },
				);
		}
	}

	/**
	 * GET /get?key=<key>
	 * Returns { value: T } if found, or { value: null } if not.
	 */
	private async handleGet(url: URL): Promise<Response> {
		const key = url.searchParams.get("key");
		if (!key) {
			return new Response(JSON.stringify({ error: "Missing key parameter" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		const value = (await this.ctx.storage.get(key)) ?? null;
		return new Response(JSON.stringify({ value }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	/**
	 * POST /put
	 * Body: { key: string; value: unknown }
	 */
	private async handlePut(request: Request): Promise<Response> {
		let body: { key: string; value: unknown };
		try {
			body = await request.json();
		} catch {
			return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (!body.key) {
			return new Response(JSON.stringify({ error: "Missing key in body" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		await this.ctx.storage.put(body.key, body.value);
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	/**
	 * POST /delete
	 * Body: { keys: string[] }
	 * Returns: { deleted: number }
	 */
	private async handleDelete(request: Request): Promise<Response> {
		let body: { keys: string[] };
		try {
			body = await request.json();
		} catch {
			return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (!Array.isArray(body.keys)) {
			return new Response(
				JSON.stringify({ error: "Missing or invalid keys array" }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}

		const deleted = await this.ctx.storage.delete(body.keys);
		return new Response(JSON.stringify({ deleted }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}
}

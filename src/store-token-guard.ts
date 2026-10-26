import { PUBLIC_ROUTES } from "./routes";

const HTTP_UNAUTHORIZED = 401;

// Minimum validity a token must have left. Global tokens last ~24h and the
// keep-warm alarm first refreshes them after 11h, so anything shorter may
// expire before it is ever refreshed. Keep in sync with oauth-callback.js.
export const MIN_TOKEN_VALIDITY_MS = 12 * 60 * 60 * 1000;

type FetchHandler = (
	request: Request,
	env: any,
	ctx: ExecutionContext,
) => Promise<Response>;

type StoreTokenBody = {
	token?: {
		data?: { refreshToken?: unknown; tokenExpiryDuration?: unknown };
	};
} | null;

/**
 * A token is unusable if it has no refresh token or expires within
 * MIN_TOKEN_VALIDITY_MS (tokenExpiryDuration is an absolute epoch-ms expiry,
 * despite its name).
 */
function isUnusableToken(body: StoreTokenBody): boolean {
	const data = body?.token?.data;
	if (!data) {
		// Missing token is rejected by the auth package itself.
		return false;
	}
	const expiresAt = data.tokenExpiryDuration;
	return (
		!data.refreshToken ||
		(typeof expiresAt === "number" &&
			expiresAt - Date.now() < MIN_TOKEN_VALIDITY_MS)
	);
}

/**
 * Treats POST /store-token with an expiring token, or one without a refresh
 * token, as a 401 instead of minting a grant that would fail on first use.
 */
export function withExpiredTokenGuard(handler: FetchHandler): FetchHandler {
	return async (request, env, ctx) => {
		const { pathname } = new URL(request.url);
		if (pathname !== PUBLIC_ROUTES.storeToken || request.method !== "POST") {
			return handler(request, env, ctx);
		}

		let body: StoreTokenBody;
		try {
			body = await request.clone().json();
		} catch {
			// Unparseable bodies are rejected by the auth package itself.
			return handler(request, env, ctx);
		}
		if (isUnusableToken(body)) {
			console.error(
				"Rejecting /store-token: token expired or missing refresh token",
			);
			return new Response("Unauthorized", { status: HTTP_UNAUTHORIZED });
		}
		return handler(request, env, ctx);
	};
}

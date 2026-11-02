import { fetchApi } from "../../rest-utils";
import type { BachSession, ClientContext } from "../../types";

/*
 * Initiate a new BACH pinboard session for a liveboard.
 */
export async function createBachPinboardSession(
	ctx: ClientContext,
	{ liveboardId }: { liveboardId: string },
): Promise<BachSession> {
	const endpoint = "/callosum/v1/bach/pinboard/";
	// Java callers (e.g. BachPinboardRequestBuilder) seed the session with a fresh GUID rather
	// than leaving the field empty; mirror that to avoid validation rejections.
	const clientTransactionId = crypto.randomUUID();
	const response = await fetchApi(ctx, endpoint, {
		json: {
			pinboardSession: { transactionId: clientTransactionId },
			pinboardRequests: [
				{
					type: "LOAD_PINBOARD",
					loadPinboard: { savedPinboardId: liveboardId },
				},
			],
		},
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`createBachPinboardSession failed with status ${response.status}: ${errorText}`,
		);
	}

	const data = (await response.json()) as {
		status?: {
			statusCode?: string;
			errorMessage?: string;
			errorCode?: string;
		};
		pinboardSession?: {
			transactionId?: string;
			generationNumber?: string | number;
		};
		pinboardResponses?: Array<{
			loadPinboard?: {
				status?: { statusCode?: string; errorMessage?: string };
			};
			status?: { statusCode?: string; errorMessage?: string };
		}>;
	};

	const statusCode = data?.status?.statusCode;
	if (statusCode && statusCode !== "OK") {
		const detail =
			data.status?.errorMessage ||
			data.pinboardResponses?.[0]?.loadPinboard?.status?.errorMessage ||
			data.pinboardResponses?.[0]?.status?.errorMessage ||
			JSON.stringify(data.status);
		throw new Error(
			`createBachPinboardSession returned non-OK status ${statusCode}: ${detail}`,
		);
	}

	const transactionId = data?.pinboardSession?.transactionId;
	const generationNumber = data?.pinboardSession?.generationNumber;
	if (!transactionId || generationNumber === undefined) {
		throw new Error(
			`createBachPinboardSession: missing session ids in response: ${JSON.stringify(data)}`,
		);
	}
	return { transactionId, generationNumber: String(generationNumber) };
}

/*
 * Save the current state of the pinboard.
 */
export async function saveBachPinboard(
	ctx: ClientContext,
	{
		transactionId,
		generationNumber,
	}: {
		transactionId: string;
		generationNumber: string;
	},
): Promise<void> {
	const endpoint = "/callosum/v1/bach/pinboard/";
	const response = await fetchApi(ctx, endpoint, {
		json: {
			pinboardSession: { transactionId, generationNumber },
			pinboardRequests: [
				{
					type: "SAVE_PINBOARD",
					savePinboard: {},
				},
			],
		},
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`saveBachPinboard failed with status ${response.status}: ${errorText}`,
		);
	}

	const data = (await response.json()) as {
		status?: {
			statusCode?: string;
			errorMessage?: string;
			errorCode?: string;
		};
		pinboardResponses?: Array<{
			savePinboard?: {
				status?: { statusCode?: string; errorMessage?: string };
			} | null;
			status?: { statusCode?: string; errorMessage?: string };
		}>;
	} | null;

	// Without this, a null or non-object body skips the status check below and the save is
	// reported as successful. Saving is what promotes the edit session to the saved liveboard, so
	// a false success here means the user's changes are silently lost.
	if (!data || typeof data !== "object") {
		throw new Error(
			`saveBachPinboard failed: non-object response body: ${JSON.stringify(data)}`,
		);
	}

	const statusCode = data?.status?.statusCode;
	if (statusCode && statusCode !== "OK") {
		const detail =
			data.status?.errorMessage ||
			data.pinboardResponses?.[0]?.savePinboard?.status?.errorMessage ||
			data.pinboardResponses?.[0]?.status?.errorMessage ||
			JSON.stringify(data.status);
		throw new Error(
			`saveBachPinboard returned non-OK status ${statusCode}: ${detail}`,
		);
	}
}

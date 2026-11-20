// get_file: a file the Analytics Agent produced in a conversation (e.g. a CSV
// from code execution). The convex download route serves every type as
// `application/octet-stream`, so the type comes from the file name.

import { fetchApi } from "../../rest-utils";
import { type ClientContext, ThoughtSpotApiError } from "../../types";

export const GET_FILE_DEFAULT_MAX_ROWS = 100;
export const GET_FILE_MAX_ROWS_LIMIT = 1000;

const MB = 1024 * 1024;
// A CSV is parsed and row-capped, so it can be larger than content returned whole.
const CSV_MAX_BYTES = 10 * MB;
// Returned in-band as base64, which costs the client about 4/3 of this.
const BINARY_MAX_BYTES = 5 * MB;

export type ConversationFileKind = "csv" | "pdf" | "image";

export interface ConversationFileFormat {
	kind: ConversationFileKind;
	mimeType: string;
	maxBytes: number;
}

const FILE_FORMATS: Record<string, ConversationFileFormat> = {
	csv: { kind: "csv", mimeType: "text/csv", maxBytes: CSV_MAX_BYTES },
	pdf: { kind: "pdf", mimeType: "application/pdf", maxBytes: BINARY_MAX_BYTES },
	png: { kind: "image", mimeType: "image/png", maxBytes: BINARY_MAX_BYTES },
	jpg: { kind: "image", mimeType: "image/jpeg", maxBytes: BINARY_MAX_BYTES },
	jpeg: { kind: "image", mimeType: "image/jpeg", maxBytes: BINARY_MAX_BYTES },
};

// The format get_file returns for a file extension, or undefined when unsupported.
export function conversationFileFormat(
	extension: string,
): ConversationFileFormat | undefined {
	return Object.hasOwn(FILE_FORMATS, extension)
		? FILE_FORMATS[extension]
		: undefined;
}

export class UnsupportedFileTypeError extends Error {
	constructor(readonly fileType: string) {
		super(`Unsupported file type: ${fileType || "(none)"}`);
		this.name = "UnsupportedFileTypeError";
	}
}

export class FileTooLargeError extends Error {
	constructor(readonly maxBytes: number) {
		super(`File is larger than ${maxBytes} bytes`);
		this.name = "FileTooLargeError";
	}
}

/*
 * Download a file of a Spotter 3 conversation. Runs as the calling user: the
 * route re-checks the download privileges and the file's expiry on every call.
 */
export async function downloadSpotter3File(
	ctx: ClientContext,
	{
		conversationId,
		tsFileId,
	}: {
		conversationId: string;
		tsFileId: string;
	},
): Promise<Response> {
	const endpoint = `/conversation/v2/${encodeURIComponent(conversationId)}/download/${encodeURIComponent(tsFileId)}`;
	const response = await fetchApi(ctx, endpoint, {
		method: "GET",
		accept: "*/*",
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(
			response.status,
			"downloadSpotter3File",
			errorText,
		);
	}

	return response;
}

/*
 * Read a response body, giving up once it passes `maxBytes` so a large file
 * cannot exhaust the Worker's memory.
 */
export async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel();
		throw new FileTooLargeError(maxBytes);
	}

	const reader = response.body?.getReader();
	if (!reader) {
		return new Uint8Array();
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new FileTooLargeError(maxBytes);
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

// Base64 in slices: String.fromCharCode(...bytes) overflows the stack on a large file.
export function bytesToBase64(bytes: Uint8Array): string {
	const SLICE = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += SLICE) {
		binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
	}
	return btoa(binary);
}

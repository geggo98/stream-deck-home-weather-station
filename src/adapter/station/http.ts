/**
 * One bounded HTTP request: timeout over headers AND body, streaming size cap, explicit JSON
 * parsing. Everything that talks to the service goes through here, so the limits cannot be
 * forgotten by a new call site.
 *
 * Why these choices:
 *  - `redirect: "error"`: a redirect would forward a client secret or bearer token to
 *    wherever the response points. The service has no documented redirects; fail instead.
 *  - The size cap is enforced while reading, not after buffering: a hostile or broken
 *    server must not be able to make us allocate more than the cap.
 *  - Error messages never include the URL (it may carry a query) or the foreign error text.
 */

import { NetatmoError } from "./errors.ts";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface HttpLimits {
	readonly timeoutMs: number;
	readonly maxBytes: number;
	/** Aborts the request from outside (a cancelled sign-in); reported as a transient failure. */
	readonly signal?: AbortSignal;
}

export interface HttpRequest {
	readonly method: "GET" | "POST";
	readonly headers?: Record<string, string>;
	readonly body?: string;
}

export interface HttpResult {
	readonly status: number;
	readonly headers: Headers;
	readonly bytes: number;
	/** Parsed body, or undefined when the body is empty or not JSON. */
	readonly json: unknown;
	readonly jsonValid: boolean;
}

/** Refuse to send credentials in clear text anywhere but to the local machine (tests, loopback). */
export function assertSafeBaseUrl(baseUrl: string): URL {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("baseUrl is not a valid URL");
	}
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("baseUrl must use https (plain http is only allowed for loopback hosts)");
	}
	return url;
}

export function joinUrl(baseUrl: string, pathAndQuery: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${pathAndQuery}`;
}

/**
 * Parse a Retry-After header: delta-seconds or HTTP-date (RFC 9110 section 10.2.3).
 * Returns the wait in milliseconds, or undefined when absent or malformed.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
	if (value === null) return undefined;
	const text = value.trim();
	if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
	// V8 parses odd strings as dates ("-5" is a year); the three HTTP-date formats all start with a day name
	if (text.length === 0 || text.length > 64 || !/^[A-Za-z]{3,9},?\s/.test(text)) return undefined;
	const at = Date.parse(text);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function networkCode(error: unknown): string {
	const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
	const code = cause?.code ?? (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code) ? code : "unknown";
}

export async function httpRequest(
	fetchImpl: typeof fetch,
	url: string,
	request: HttpRequest,
	limits: HttpLimits,
): Promise<HttpResult> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, limits.timeoutMs);
	const onExternalAbort = (): void => controller.abort();
	if (limits.signal?.aborted) controller.abort();
	else limits.signal?.addEventListener("abort", onExternalAbort, { once: true });
	const fail = (error: unknown): NetatmoError =>
		timedOut
			? new NetatmoError("transient", "The request timed out")
			: new NetatmoError("transient", `Network error (${networkCode(error)})`);
	try {
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				signal: controller.signal,
				redirect: "error",
			});
		} catch (error) {
			throw fail(error);
		}

		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > limits.maxBytes) {
			controller.abort();
			throw new NetatmoError("protocol", "The response is larger than the allowed maximum", { status: response.status });
		}

		const chunks: Uint8Array[] = [];
		let total = 0;
		if (response.body) {
			const reader = response.body.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					total += value.byteLength;
					if (total > limits.maxBytes) {
						// stop reading AND tear the connection down; the server may still be sending
						controller.abort();
						await reader.cancel().catch(() => undefined);
						throw new NetatmoError("protocol", "The response is larger than the allowed maximum", { status: response.status });
					}
					chunks.push(value);
				}
			} catch (error) {
				if (error instanceof NetatmoError) throw error;
				throw fail(error);
			}
		}

		const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
		let json: unknown;
		let jsonValid = false;
		if (text.length > 0) {
			try {
				json = JSON.parse(text);
				jsonValid = true;
			} catch {
				// non-JSON bodies (an HTML 502 page) are normal for error statuses; the caller decides
			}
		}
		return { status: response.status, headers: response.headers, bytes: total, json, jsonValid };
	} finally {
		clearTimeout(timer);
		limits.signal?.removeEventListener("abort", onExternalAbort);
	}
}

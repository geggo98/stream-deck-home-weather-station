/**
 * Error taxonomy of the adapter. The poller and the plugin layer branch on `kind` only;
 * `message` is written by us (never copied from a response body) so it is safe to show in
 * the Property Inspector and to log.
 *
 *   auth          the user must sign in again (refresh token rejected, app deactivated,
 *                 scope missing). Retrying with the same credentials is pointless.
 *   rate-limited  the service asked us to slow down; `retryAt` (epoch ms) may be set.
 *   transient     network, timeout, 5xx: retry later with backoff.
 *   protocol      the service answered, but not in a way we understand (malformed JSON,
 *                 oversized body, unexpected status). Treated like transient by the poller.
 */

export type NetatmoErrorKind = "auth" | "rate-limited" | "transient" | "protocol";

export interface NetatmoErrorDetails {
	/** HTTP status of the response that caused this error, if any. */
	readonly status?: number;
	/** Service error code (API `error.code`) or OAuth `error` type, already sanitised. */
	readonly code?: string;
	/** Epoch ms before which retrying is pointless (from Retry-After or a documented limit). */
	readonly retryAt?: number;
}

export class NetatmoError extends Error {
	readonly kind: NetatmoErrorKind;
	readonly status: number | undefined;
	readonly code: string | undefined;
	readonly retryAt: number | undefined;

	constructor(kind: NetatmoErrorKind, message: string, details: NetatmoErrorDetails = {}) {
		super(message);
		this.name = "NetatmoError";
		this.kind = kind;
		this.status = details.status;
		this.code = details.code;
		this.retryAt = details.retryAt;
	}
}

export function isNetatmoError(value: unknown): value is NetatmoError {
	return value instanceof NetatmoError;
}

/**
 * Wrap anything thrown into a NetatmoError with a generic, safe message. The original
 * message of a foreign error may contain URLs or response fragments, so it is dropped.
 */
export function toNetatmoError(value: unknown): NetatmoError {
	if (value instanceof NetatmoError) return value;
	return new NetatmoError("transient", "Unexpected internal error");
}

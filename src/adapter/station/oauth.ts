/**
 * OAuth2 token endpoint calls (refresh and authorization-code exchange) and the mapping of
 * their failures onto the error taxonomy.
 *
 * Source of the facts: Netatmo developer docs, page "oauth" (fetched 2026-11-13, see
 * docs/WEATHER-API.md). Response fields: access_token, expires_in (example 10800), refresh_token.
 * OAuth errors are `{error, error_description}`; API errors are `{error:{code,message}}`.
 *
 * Failure policy: 429, 5xx and network problems are transient; a 4xx is a credential
 * rejection ("auth", sticky) ONLY when its body names one (see classifyTokenFailure); any
 * other 4xx is "protocol" (retried with backoff, not sticky). Bodies are never copied into
 * messages.
 */

import { NetatmoError } from "./errors.ts";
import {
	type HttpLimits,
	type HttpResult,
	httpRequest,
	joinUrl,
	parseRetryAfter,
} from "./http.ts";
import { isCleanToken } from "./credentials.ts";

export const SCOPE = "read_station";
/** Pause after a usage-limit answer (403 code 26); same value as the data endpoint uses. */
export const USAGE_LIMIT_PAUSE_MS = 10 * 60_000;
/** Upper bound for a trusted `expires_in`; the docs show 10800 (3 h). */
const MAX_EXPIRES_IN_SECONDS = 24 * 3600;

export interface TokenGrant {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly expiresInSeconds: number;
}

/** Accepts only the documented OAuth error identifiers; anything else is dropped. */
export function oauthErrorType(json: unknown): string | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const error = (json as { error?: unknown }).error;
	return typeof error === "string" && /^[a-z_]{1,40}$/.test(error) ? error : undefined;
}

/** Numeric or string API error code (`{"error":{"code":3}}`), sanitised to a short token. */
export function apiErrorCode(json: unknown): string | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const error = (json as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "number" && Number.isInteger(code)) return String(code);
	return typeof code === "string" && /^-?\d{1,4}$/.test(code) ? code : undefined;
}

export function parseTokenGrant(json: unknown): TokenGrant | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const r = json as Record<string, unknown>;
	if (!isCleanToken(r.access_token) || !isCleanToken(r.refresh_token)) return undefined;
	const expires = r.expires_in;
	if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) return undefined;
	return {
		accessToken: r.access_token,
		refreshToken: r.refresh_token,
		expiresInSeconds: Math.min(Math.floor(expires), MAX_EXPIRES_IN_SECONDS),
	};
}

export function classifyTokenFailure(result: HttpResult, now: number): NetatmoError {
	const status = result.status;
	const type = oauthErrorType(result.json);
	const code = type ?? apiErrorCode(result.json);
	if (status === 429) {
		const wait = parseRetryAfter(result.headers.get("retry-after"), now);
		return new NetatmoError("rate-limited", "The service is rate limiting token requests", {
			status,
			code,
			retryAt: wait === undefined ? undefined : now + wait,
		});
	}
	if (status === 408 || status >= 500) {
		return new NetatmoError("transient", `The token service is unavailable (HTTP ${status})`, { status, code });
	}
	if (status >= 400 && status < 500) {
		// Only a body that NAMES a credential rejection makes the failure sticky ("auth": polling
		// stops, the PI says "sign in again"). Evidence: the Netatmo OAuth docs list
		// invalid_grant and invalid_request for the token endpoint; a live probe with a bogus
		// refresh token answered 400 invalid_client; API code 30 is "invalid refresh token", 5
		// "application deactivated" (docs/WEATHER-API.md, Errors). RFC 6749 section 5.2 adds
		// unauthorized_client. Everything else in the 4xx range does not tell us that the
		// credentials are bad: a bare 401/403/404 from a proxy or gateway, an HTML page,
		// unsupported_grant_type or invalid_scope (our request, not the user's secret), a
		// 403 code 26 (usage limit). Those must not stick until the next restart, so they are
		// "protocol" (backoff and retry, capped at one hour) or "rate-limited".
		const apiCode = apiErrorCode(result.json);
		if (type === "invalid_grant" || apiCode === "30") {
			return new NetatmoError("auth", "The refresh token was rejected or has been revoked. Sign in again.", { status, code });
		}
		if (type === "invalid_client" || type === "unauthorized_client") {
			return new NetatmoError("auth", "The client ID or client secret was rejected.", { status, code });
		}
		if (type === "invalid_request") {
			return new NetatmoError("auth", "The token request was rejected as invalid. Sign in again.", { status, code });
		}
		if (apiCode === "5") {
			return new NetatmoError("auth", "The Netatmo app has been deactivated. Check the app in the developer portal.", { status, code });
		}
		if (apiCode === "26") {
			return new NetatmoError("rate-limited", "The usage limit of the account or app is reached", { status, code, retryAt: now + USAGE_LIMIT_PAUSE_MS });
		}
		return new NetatmoError("protocol", `The token service refused the request (HTTP ${status}); this does not look like a rejected credential, so it will be retried later.`, { status, code });
	}
	return new NetatmoError("protocol", `Unexpected response from the token service (HTTP ${status})`, { status, code });
}

/**
 * POST a form to /oauth2/token and return the grant. Throws NetatmoError only.
 * The caller persists the grant; this function stores nothing.
 */
export async function requestToken(
	fetchImpl: typeof fetch,
	baseUrl: string,
	form: Readonly<Record<string, string>>,
	limits: HttpLimits,
	now: () => number,
): Promise<TokenGrant> {
	const result = await httpRequest(
		fetchImpl,
		joinUrl(baseUrl, "/oauth2/token"),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
				Accept: "application/json",
			},
			body: new URLSearchParams(form).toString(),
		},
		limits,
	);
	if (result.status >= 200 && result.status < 300) {
		const grant = parseTokenGrant(result.json);
		if (!grant) {
			throw new NetatmoError("protocol", "The token service returned an unexpected response", { status: result.status });
		}
		return grant;
	}
	throw classifyTokenFailure(result, now());
}

/**
 * HTTP client for getstationsdata and getmeasure (history).
 *
 * `getMeasure` is `GET {baseUrl}/api/getmeasure?<query>` (query built in history-parse.ts);
 * it shares the token manager, the error mapping below and the optional local request budget
 * with getstationsdata. Differences: it is optional traffic, so an exhausted budget refuses
 * it and a 429 is returned at once instead of being slept through.
 *
 * Request: `GET {baseUrl}/api/getstationsdata?get_favorites=false` with
 * `Authorization: Bearer`. GET is what Netatmo's OpenAPI document specifies; pyatmo POSTs the
 * same endpoint. Equivalence is UNVERIFIED against the live service; `scripts/probe-api.ts`
 * checks both (see docs/WEATHER-API.md). `get_favorites=false`: own stations only (favourites
 * are public stations with outdoor values, a different data set).
 *
 * Error mapping (status + code, from the "general" docs page; the combinations a live
 * expired token produces are UNVERIFIED, hence both 401 and 403 code 3 are handled):
 *   401 (any), 403 code 1/2/3   token expired or invalid -> refresh ONCE, retry ONCE
 *   403 code 30 / -1 / -2 / 13  auth: refresh token invalid, grant invalid, operation forbidden
 *   403 code 26                 rate-limited ("Maximum usage reached"), 10 min default pause
 *   406 code 5                  auth: application deactivated
 *   429                         rate-limited; Retry-After <= 60 s is waited out once, longer
 *                               values are returned to the poller as `retryAt`
 *   408, 5xx                    transient
 *
 * Bodies are never copied into messages: they can contain account e-mail, coordinates and
 * MAC addresses. Only the status and the numeric code are used.
 */

import { type AdapterLogger, scopedLogger } from "../logging.ts";
import { NetatmoError } from "./errors.ts";
import {
	DEFAULT_MAX_RESPONSE_BYTES,
	DEFAULT_TIMEOUT_MS,
	type HttpResult,
	assertSafeBaseUrl,
	httpRequest,
	joinUrl,
	parseRetryAfter,
} from "./http.ts";
import { type RequestBudget } from "./budget.ts";
import { USAGE_LIMIT_PAUSE_MS, apiErrorCode, oauthErrorType } from "./oauth.ts";
import { parseStationsResponse } from "./parse.ts";
import { DEFAULT_BASE_URL, type TokenProvider } from "./token-manager.ts";
import type { StationSnapshot } from "./types.ts";

/** Longest Retry-After we sleep through inside one request (pyatmo uses the same cap). */
export const MAX_IN_REQUEST_WAIT_MS = 60_000;
/** Pause applied for 403 code 26 ("Maximum usage reached") which carries no Retry-After. Defined in oauth.ts (shared with the token endpoint). */
export { USAGE_LIMIT_PAUSE_MS };

export interface ClientOptions {
	readonly tokens: TokenProvider;
	readonly fetchImpl?: typeof fetch;
	readonly baseUrl?: string;
	readonly now?: () => number;
	readonly logger?: AdapterLogger;
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
	/** Injectable so tests do not really sleep. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Shared local request counter; every real request is recorded, optional ones (getMeasure) are checked first. */
	readonly budget?: RequestBudget;
}

export interface MeasureRequestOptions {
	/** Aborts the request (credentials changed); reported as a transient failure. */
	readonly signal?: AbortSignal;
}

interface CallOptions {
	/** Label for the debug line: the endpoint name, never a query. */
	readonly label: string;
	readonly send: (token: string) => Promise<HttpResult>;
	/** Sleep through a short Retry-After once (poller) or hand it back at once (optional requests). */
	readonly waitOn429: boolean;
}

export interface StationsRequestOptions {
	readonly method?: "GET" | "POST";
}

const EXPIRED_CODES = new Set(["1", "2", "3"]);
const AUTH_CODES = new Set(["30", "-1", "-2", "13"]);

export class NetatmoClient {
	private readonly tokens: TokenProvider;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;
	private readonly now: () => number;
	private readonly log: AdapterLogger;
	private readonly timeoutMs: number;
	private readonly maxBytes: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly budget: RequestBudget | undefined;

	constructor(options: ClientOptions) {
		this.tokens = options.tokens;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		assertSafeBaseUrl(this.baseUrl);
		this.now = options.now ?? Date.now;
		this.log = options.logger ?? scopedLogger("netatmo.client");
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.budget = options.budget;
	}

	/** The validated JSON envelope of getstationsdata, otherwise untouched. Throws NetatmoError only. */
	async getStationsDataRaw(options: StationsRequestOptions = {}): Promise<unknown> {
		const method = options.method ?? "GET";
		return this.call({ label: `getstationsdata ${method}`, send: (token) => this.send(token, method), waitOn429: true });
	}

	/**
	 * The validated JSON envelope of GET /api/getmeasure (`query` comes from buildMeasureQuery).
	 * Optional traffic: refused with a rate-limited error when the local budget is nearly used up,
	 * and a 429 is never slept through. Same token manager and refresh-once rule as the poller.
	 */
	async getMeasure(query: string, options: MeasureRequestOptions = {}): Promise<unknown> {
		if (this.budget) {
			const check = this.budget.check(this.now());
			if (!check.ok) throw new NetatmoError("rate-limited", "The local request budget is used up for now", { retryAt: check.retryAt });
		}
		const limits = { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes, signal: options.signal };
		return this.call({
			label: "getmeasure",
			waitOn429: false,
			send: (token) =>
				httpRequest(this.fetchImpl, joinUrl(this.baseUrl, `/api/getmeasure?${query}`), { method: "GET", headers: this.headers(token) }, limits),
		});
	}

	private async call(call: CallOptions): Promise<unknown> {
		let refreshed = false;
		let waited = false;
		let token = await this.tokens.getAccessToken();
		for (;;) {
			const started = this.now();
			this.budget?.record(started);
			const result = await call.send(token);
			this.log.debug(`${call.label} -> HTTP ${result.status} (${this.now() - started} ms, ${result.bytes} bytes)`);
			if (result.status >= 200 && result.status < 300) return this.checkEnvelope(result);

			const code = apiErrorCode(result.json);
			const status = result.status;

			if (status === 401 || (status === 403 && code !== undefined && EXPIRED_CODES.has(code))) {
				if (refreshed) {
					throw new NetatmoError("auth", "The service rejected the refreshed access token. Sign in again.", { status, code });
				}
				refreshed = true;
				token = await this.tokens.forceRefresh(token);
				continue;
			}
			if (status === 429) {
				const wait = parseRetryAfter(result.headers.get("retry-after"), this.now());
				if (call.waitOn429 && wait !== undefined && wait <= MAX_IN_REQUEST_WAIT_MS && !waited) {
					waited = true;
					this.log.info(`rate limited; waiting ${Math.ceil(wait / 1000)} s as requested`);
					await this.sleep(wait);
					continue;
				}
				throw new NetatmoError("rate-limited", "The service is rate limiting requests", {
					status,
					code,
					retryAt: wait === undefined ? undefined : this.now() + wait,
				});
			}
			throw this.mapFailure(result, code);
		}
	}

	private headers(token: string): Record<string, string> {
		return { Authorization: `Bearer ${token}`, Accept: "application/json" };
	}

	async fetchSnapshot(options: StationsRequestOptions = {}): Promise<StationSnapshot> {
		const raw = await this.getStationsDataRaw(options);
		return parseStationsResponse(raw, this.now(), { warn: (m) => this.log.warn(m) });
	}

	private send(token: string, method: "GET" | "POST"): Promise<HttpResult> {
		const headers = this.headers(token);
		const limits = { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes };
		if (method === "GET") {
			return httpRequest(this.fetchImpl, joinUrl(this.baseUrl, "/api/getstationsdata?get_favorites=false"), { method, headers }, limits);
		}
		return httpRequest(
			this.fetchImpl,
			joinUrl(this.baseUrl, "/api/getstationsdata"),
			{
				method,
				headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
				body: "get_favorites=false",
			},
			limits,
		);
	}

	private checkEnvelope(result: HttpResult): unknown {
		if (!result.jsonValid || typeof result.json !== "object" || result.json === null) {
			throw new NetatmoError("protocol", "The service returned malformed JSON", { status: result.status });
		}
		const env = result.json as { status?: unknown; body?: unknown };
		if (env.status !== undefined && env.status !== "ok") {
			throw new NetatmoError("protocol", "The service reported a failure in a successful response", { status: result.status });
		}
		if (typeof env.body !== "object" || env.body === null) {
			throw new NetatmoError("protocol", "The response has no body object", { status: result.status });
		}
		return result.json;
	}

	private mapFailure(result: HttpResult, code: string | undefined): NetatmoError {
		const status = result.status;
		const oauth = oauthErrorType(result.json);
		const details = { status, code: code ?? oauth };
		if (status === 403) {
			if (code !== undefined && AUTH_CODES.has(code)) {
				const message = code === "13" ? "The access token is not permitted to read station data (missing read_station scope?). Sign in again." : "The service rejected the credentials. Sign in again.";
				return new NetatmoError("auth", message, details);
			}
			if (code === "26") {
				return new NetatmoError("rate-limited", "The usage limit of the account or app is reached", { ...details, retryAt: this.now() + USAGE_LIMIT_PAUSE_MS });
			}
			return new NetatmoError("protocol", "The service refused the request (HTTP 403)", details);
		}
		if (status === 406 && code === "5") {
			return new NetatmoError("auth", "The Netatmo app has been deactivated. Check the app in the developer portal.", details);
		}
		if (status === 408 || status >= 500) {
			return new NetatmoError("transient", `The service is unavailable (HTTP ${status})`, details);
		}
		return new NetatmoError("protocol", `Unexpected response from the service (HTTP ${status})`, details);
	}
}

/**
 * History for the history key: cache, coalescing, throttle and generation safety around
 * `NetatmoClient.getMeasure`. SDK-free; the service layer (create-service.ts) wires it to the
 * same client, token manager and request budget the poller uses.
 *
 *  - cache: 10 minutes per (station, module, metric, window); stations only upload that often;
 *  - coalescing: concurrent identical requests share ONE HTTP call;
 *  - throttle: at most one real request per combination per 30 s. Failures are remembered for
 *    30 s (rate-limit failures until the service's `retryAt`, at most 10 min), so a key that
 *    repaints in a loop cannot hammer the service;
 *  - generations: `invalidate()` (credentials changed or cleared) aborts what is in flight,
 *    empties the cache and bumps the generation. A result fetched under the old generation is
 *    discarded, never cached and never returned as data (same rule as the poller and
 *    TokenManager.reset);
 *  - never throws: every failure is a `kind: "error"` result with a short, safe message.
 */

import { type AdapterLogger, scopedLogger } from "../logging.ts";
import type { NetatmoClient } from "./client.ts";
import { NetatmoError, toNetatmoError } from "./errors.ts";
import {
	MEASURE_SPECS,
	SUPPORTED_BY_MODULE,
	WINDOW_MS,
	buildMeasureQuery,
	measureBodyOf,
	parseMeasureBody,
	scaleFor,
	scaleMs,
} from "./history-parse.ts";
import type { HistoryRequest, HistoryResult, StationSnapshot } from "./types.ts";

export const HISTORY_CACHE_TTL_MS = 10 * 60_000;
export const HISTORY_MIN_INTERVAL_MS = 30_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_ID_LENGTH = 64;

export interface HistoryServiceOptions {
	readonly client: Pick<NetatmoClient, "getMeasure">;
	readonly getSnapshot: () => StationSnapshot | undefined;
	readonly hasCredentials: () => Promise<boolean>;
	readonly now: () => number;
	readonly logger?: AdapterLogger;
}

interface CacheEntry {
	readonly result: HistoryResult;
	readonly expiresAt: number;
}

type ErrorResult = Extract<HistoryResult, { kind: "error" }>;

export class HistoryService {
	private readonly opts: HistoryServiceOptions;
	private readonly log: AdapterLogger;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, Promise<HistoryResult>>();
	private readonly controllers = new Set<AbortController>();
	private generation = 0;

	constructor(options: HistoryServiceOptions) {
		this.opts = options;
		this.log = options.logger ?? scopedLogger("netatmo.history");
	}

	/** Credentials changed or cleared: forget everything and cancel in-flight requests. */
	invalidate(): void {
		this.generation++;
		this.cache.clear();
		this.inflight.clear();
		for (const controller of this.controllers) controller.abort();
		this.controllers.clear();
	}

	async getHistory(request: HistoryRequest): Promise<HistoryResult> {
		const refusal = this.validate(request);
		if (refusal) return refusal;
		const key = `${request.stationId}|${request.moduleId}|${request.metric}|${request.window}`;
		const now = this.opts.now();

		const cached = this.cache.get(key);
		if (cached) {
			if (cached.expiresAt > now) return cached.result;
			this.cache.delete(key);
		}
		const running = this.inflight.get(key);
		if (running) return running;

		const generation = this.generation;
		const controller = new AbortController();
		this.controllers.add(controller);
		const promise = this.load(request, key, generation, controller.signal).finally(() => {
			this.controllers.delete(controller);
			if (this.inflight.get(key) === promise) this.inflight.delete(key);
		});
		this.inflight.set(key, promise);
		return promise;
	}

	/** Shape and snapshot checks; no I/O. Returns an error result or undefined when the request may go out. */
	private validate(request: HistoryRequest): ErrorResult | undefined {
		const fail = (reason: ErrorResult["reason"], message: string): ErrorResult => ({ kind: "error", request, reason, message });
		const r = request as unknown as Record<string, unknown>;
		const idOk = (v: unknown): boolean => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
		if (
			!idOk(r.stationId) ||
			!idOk(r.moduleId) ||
			typeof r.metric !== "string" ||
			!Object.hasOwn(MEASURE_SPECS, r.metric) ||
			typeof r.window !== "string" ||
			!Object.hasOwn(WINDOW_MS, r.window)
		) {
			return fail("unsupported", "This history request is not valid.");
		}
		const snapshot = this.opts.getSnapshot();
		if (!snapshot) return fail("transient", "Station data is not loaded yet.");
		const module = snapshot.stations.find((s) => s.id === request.stationId)?.modules.find((m) => m.id === request.moduleId);
		if (!module) return fail("unsupported", "This sensor is not part of the station data.");
		if (!SUPPORTED_BY_MODULE[module.type].includes(request.metric)) return fail("unsupported", "This sensor has no history for this value.");
		return undefined;
	}

	private async load(request: HistoryRequest, key: string, generation: number, signal: AbortSignal): Promise<HistoryResult> {
		const discarded: ErrorResult = {
			kind: "error",
			request,
			reason: "transient",
			message: "The sign-in changed while loading. Try again.",
		};
		let result: HistoryResult;
		let ttl = HISTORY_CACHE_TTL_MS;
		try {
			if (!(await this.opts.hasCredentials())) {
				if (generation !== this.generation) return discarded;
				return { kind: "error", request, reason: "auth", message: "Not signed in." };
			}
			if (generation !== this.generation) return discarded;
			const started = this.opts.now();
			const json = await this.opts.client.getMeasure(buildMeasureQuery(request, started), { signal });
			const parsed = parseMeasureBody(measureBodyOf(json), request.metric, scaleMs(scaleFor(request)));
			this.log.debug(`history ${request.metric} ${request.window}: ${parsed.points.length} point(s)`);
			result = { kind: "ok", request, points: parsed.points, stepMs: parsed.stepMs, fetchedAt: this.opts.now() };
		} catch (error) {
			if (generation !== this.generation) return discarded;
			const failure = toNetatmoError(error, this.log);
			result = { kind: "error", request, reason: reasonOf(failure), message: failure.message };
			ttl = failure.kind === "rate-limited" && failure.retryAt !== undefined
				? Math.min(HISTORY_CACHE_TTL_MS, Math.max(HISTORY_MIN_INTERVAL_MS, failure.retryAt - this.opts.now()))
				: HISTORY_MIN_INTERVAL_MS;
			// A protocol failure (the answer's shape is not what the parser expects) is persistent and
			// invisible otherwise (the key just says "No history"), and the default log level hides
			// debug: warn. Transient, rate and auth failures are already reported by the poller.
			const detail = `${failure.kind}${failure.status !== undefined ? ` HTTP ${failure.status}` : ""}${failure.code !== undefined ? ` code ${failure.code}` : ""}`;
			if (failure.kind === "protocol") this.log.warn(`history ${request.metric} ${request.window} failed (${detail}): ${failure.message}`);
			else this.log.debug(`history ${request.metric} ${request.window} failed (${detail})`);
		}
		// a result fetched under old credentials must neither be cached nor shown
		if (generation !== this.generation) return discarded;
		this.remember(key, result, ttl);
		return result;
	}

	private remember(key: string, result: HistoryResult, ttl: number): void {
		this.cache.delete(key);
		this.cache.set(key, { result, expiresAt: this.opts.now() + ttl });
		while (this.cache.size > MAX_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}
}

function reasonOf(error: NetatmoError): ErrorResult["reason"] {
	switch (error.kind) {
		case "auth":
			return "auth";
		case "rate-limited":
			return "rate";
		default:
			return "transient";
	}
}

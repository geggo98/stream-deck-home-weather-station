/**
 * Schedules the periodic getstationsdata requests. Implements WeatherSource (types.ts).
 * (The history service, credential validation in the service and the browser sign-in call
 * the API too; this class owns the poll schedule, the snapshot and the connection state.)
 *
 * Rules (docs/ARCHITECTURE.md, "Data flow"):
 *  - starts with the first subscriber, stops after the last;
 *  - interval default 300 s, clamped 60..3600, +-10 % jitter (the cloud refreshes about
 *    every 10 minutes, so faster polling only burns the 500 requests/hour per-user budget);
 *  - failures back off exponentially (interval * 2^(n-1), cap 3600 s) and `Retry-After`
 *    (NetatmoError.retryAt) is respected up to that same cap;
 *  - an auth error STOPS polling until `credentialsChanged()`: retrying a dead refresh token
 *    helps nobody;
 *  - `refresh()` is coalesced with a running poll and rate-limited: at most one real request
 *    per 60 s, otherwise it resolves at once with the cached state. The same gap protects
 *    the API when keys flap between pages (subscribe 0 -> 1 -> 0 -> 1);
 *  - the last good snapshot survives errors; only a credentials change drops it;
 *  - a poll started before `credentialsChanged()` (different `epoch`) is discarded when it
 *    finishes, so an old account's data can never appear under new credentials.
 *
 * Timers and clock are injected so tests drive it with a fake clock.
 */

import { type AdapterLogger, scopedLogger } from "../logging.ts";
import { type NetatmoError, describeUnexpected, toNetatmoError } from "./errors.ts";
import type { ConnectionState, PollerSubscription, StationSnapshot, WeatherSource } from "./types.ts";

export const DEFAULT_INTERVAL_SECONDS = 300;
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 3600;
export const MIN_REQUEST_GAP_MS = 60_000;
export const JITTER_FRACTION = 0.1;
const MAX_BACKOFF_MS = MAX_INTERVAL_SECONDS * 1000;

export interface PollerTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realTimers: PollerTimers = {
	setTimeout(callback, ms) {
		const handle = setTimeout(callback, ms);
		// a pending poll must not keep a script or test process alive
		handle.unref?.();
		return handle;
	},
	clearTimeout(handle) {
		clearTimeout(handle as NodeJS.Timeout);
	},
};

export interface PollerOptions {
	readonly fetchSnapshot: () => Promise<StationSnapshot>;
	readonly hasCredentials: () => Promise<boolean>;
	/**
	 * A warning while the data is fine but something the user must know about is not (a
	 * rotated token pair that could not be written to disk). Checked after every successful
	 * poll; a value makes the state `{kind: "ok", warning}` (data stays current, no backoff,
	 * polling continues on schedule), `undefined` clears it.
	 */
	readonly warning?: () => "unpersisted-rotation" | undefined;
	readonly intervalSeconds?: number;
	readonly now?: () => number;
	/** 0..1 */
	readonly random?: () => number;
	readonly timers?: PollerTimers;
	readonly logger?: AdapterLogger;
}

export function clampIntervalSeconds(seconds: number): number {
	if (!Number.isFinite(seconds)) return DEFAULT_INTERVAL_SECONDS;
	return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds)));
}

interface Listener {
	readonly callback: () => void;
}

function sameState(a: ConnectionState, b: ConnectionState): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "error" && b.kind === "error") return a.message === b.message && a.since === b.since && a.retryAt === b.retryAt;
	if (a.kind === "auth-error" && b.kind === "auth-error") return a.message === b.message && a.since === b.since;
	if (a.kind === "ok" && b.kind === "ok") return a.warning === b.warning;
	return true;
}

export class Poller implements WeatherSource {
	private readonly opts: PollerOptions;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly timers: PollerTimers;
	private readonly log: AdapterLogger;
	private intervalMs: number;

	private snapshot: StationSnapshot | undefined;
	private state: ConnectionState = { kind: "loading" };
	private readonly listeners = new Set<Listener>();
	private timer: unknown;
	private hasTimer = false;
	private epoch = 0;
	private inflight: { readonly epoch: number; readonly promise: Promise<void> } | undefined;
	private startPromise: Promise<void> = Promise.resolve();
	private lastRequestAt = Number.NEGATIVE_INFINITY;
	private errorCount = 0;
	private errorSince = 0;
	private blockedUntil = 0;
	private pendingDelayMs: number | undefined;
	private disposed = false;

	constructor(options: PollerOptions) {
		this.opts = options;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.timers = options.timers ?? realTimers;
		this.log = options.logger ?? scopedLogger("netatmo.poller");
		this.intervalMs = clampIntervalSeconds(options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
	}

	// ---- WeatherSource ----

	getSnapshot(): StationSnapshot | undefined {
		return this.snapshot;
	}

	getConnectionState(): ConnectionState {
		return this.state;
	}

	subscribe(listener: () => void): PollerSubscription {
		const entry: Listener = { callback: listener };
		this.listeners.add(entry);
		if (this.listeners.size === 1 && !this.disposed) this.startPromise = this.start(false);
		return {
			unsubscribe: () => {
				if (!this.listeners.delete(entry)) return;
				if (this.listeners.size === 0) this.stopTimer();
			},
		};
	}

	refresh(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.state.kind === "auth-error" || this.state.kind === "no-credentials") return Promise.resolve();
		if (this.inflight && this.inflight.epoch === this.epoch) return this.inflight.promise;
		const now = this.now();
		if (now - this.lastRequestAt < MIN_REQUEST_GAP_MS) return Promise.resolve();
		if (now < this.blockedUntil) return Promise.resolve();
		return this.poll(this.epoch);
	}

	async credentialsChanged(): Promise<void> {
		if (this.disposed) return;
		this.resetForNewAccount();
		this.snapshot = undefined;
		this.state = { kind: "loading" };
		this.notify();
		if (this.listeners.size > 0) {
			this.startPromise = this.start(true);
			await this.startPromise;
			await this.inflight?.promise;
		}
	}

	// ---- additions for the service layer and tests ----

	/**
	 * Take a snapshot that was just fetched with the new credentials (setCredentials validated
	 * them with a real request) instead of fetching again.
	 */
	adoptSnapshot(snapshot: StationSnapshot): void {
		if (this.disposed) return;
		this.resetForNewAccount();
		this.snapshot = snapshot;
		this.lastRequestAt = this.now();
		this.state = this.okState();
		this.notify();
		if (this.listeners.size > 0) this.schedule(this.jittered(this.intervalMs));
	}

	setIntervalSeconds(seconds: number): void {
		this.intervalMs = clampIntervalSeconds(seconds) * 1000;
		// only a healthy schedule is re-planned; a backoff keeps its own timing
		if (this.hasTimer && this.errorCount === 0 && this.listeners.size > 0) {
			this.schedule(this.jittered(this.intervalMs));
		}
	}

	get intervalSeconds(): number {
		return this.intervalMs / 1000;
	}

	/** Resolves when the start sequence and any running poll have finished (tests, shutdown). */
	async whenIdle(): Promise<void> {
		await this.startPromise;
		await this.inflight?.promise;
	}

	dispose(): void {
		this.disposed = true;
		this.stopTimer();
		this.epoch++;
		this.listeners.clear();
	}

	// ---- internals ----

	private resetForNewAccount(): void {
		this.epoch++;
		this.stopTimer();
		this.inflight = undefined;
		this.errorCount = 0;
		this.errorSince = 0;
		this.blockedUntil = 0;
		this.pendingDelayMs = undefined;
		this.lastRequestAt = Number.NEGATIVE_INFINITY;
	}

	private jittered(ms: number): number {
		return Math.round(ms * (1 + (this.random() * 2 - 1) * JITTER_FRACTION));
	}

	private stopTimer(): void {
		if (this.hasTimer) this.timers.clearTimeout(this.timer);
		this.hasTimer = false;
		this.timer = undefined;
	}

	private schedule(delayMs: number): void {
		this.stopTimer();
		const wait = Math.max(delayMs, this.blockedUntil - this.now(), 0);
		this.hasTimer = true;
		this.timer = this.timers.setTimeout(() => {
			this.hasTimer = false;
			this.timer = undefined;
			if (this.disposed || this.listeners.size === 0) return;
			void this.poll(this.epoch);
		}, wait);
	}

	private async start(force: boolean): Promise<void> {
		const epoch = this.epoch;
		let has = false;
		try {
			has = await this.opts.hasCredentials();
		} catch (error) {
			this.log.error(`could not check credentials: ${describeUnexpected(error)}`);
		}
		if (epoch !== this.epoch || this.listeners.size === 0 || this.disposed) return;
		if (!has) {
			this.snapshot = undefined;
			this.setState({ kind: "no-credentials" });
			return;
		}
		if (this.state.kind === "auth-error") return; // sticky until credentialsChanged()
		if (this.state.kind === "no-credentials") this.setState({ kind: "loading" });

		if (!force) {
			const now = this.now();
			const sinceLast = now - this.lastRequestAt;
			if (sinceLast < MIN_REQUEST_GAP_MS) {
				// re-subscribing right after a request (page flip): do not hit the API again
				const planned = this.pendingDelayMs ?? this.jittered(this.intervalMs);
				this.schedule(Math.max(MIN_REQUEST_GAP_MS - sinceLast, planned - sinceLast));
				return;
			}
		}
		await this.poll(epoch);
	}

	private poll(epoch: number): Promise<void> {
		if (this.inflight && this.inflight.epoch === epoch) return this.inflight.promise;
		const promise = this.runPoll(epoch);
		const entry = { epoch, promise };
		this.inflight = entry;
		const clear = () => {
			if (this.inflight === entry) this.inflight = undefined;
		};
		promise.then(clear, clear);
		return promise;
	}

	private async runPoll(epoch: number): Promise<void> {
		this.lastRequestAt = this.now();
		this.stopTimer();
		let snapshot: StationSnapshot;
		try {
			snapshot = await this.opts.fetchSnapshot();
		} catch (error) {
			if (epoch !== this.epoch) return;
			this.onFailure(toNetatmoError(error, this.log));
			this.afterPoll(epoch);
			return;
		}
		if (epoch !== this.epoch) return;
		this.errorCount = 0;
		this.blockedUntil = 0;
		this.pendingDelayMs = undefined;
		this.snapshot = snapshot;
		this.state = this.okState();
		this.notify();
		this.afterPoll(epoch);
	}

	private okState(): ConnectionState {
		const warning = this.opts.warning?.();
		return warning === undefined ? { kind: "ok" } : { kind: "ok", warning };
	}

	private onFailure(error: NetatmoError): void {
		const now = this.now();
		if (error.kind === "auth") {
			this.log.warn(`polling stopped (auth${error.status !== undefined ? ` HTTP ${error.status}` : ""}${error.code !== undefined ? ` code ${error.code}` : ""}): ${error.message}`);
			const since = this.state.kind === "auth-error" ? this.state.since : now;
			this.setState({ kind: "auth-error", message: error.message, since });
			return;
		}
		this.errorCount++;
		if (this.errorCount === 1) this.errorSince = now;
		const retryAfterMs = error.retryAt === undefined ? 0 : Math.min(Math.max(0, error.retryAt - now), MAX_BACKOFF_MS);
		this.blockedUntil = retryAfterMs > 0 ? now + retryAfterMs : 0;
		const backoff = Math.min(this.intervalMs * 2 ** (this.errorCount - 1), MAX_BACKOFF_MS);
		// jitter first, then make sure neither the cap nor Retry-After is violated
		const delay = Math.min(Math.max(this.jittered(backoff), retryAfterMs), MAX_BACKOFF_MS);
		this.pendingDelayMs = delay;
		this.log.warn(`poll failed (${error.kind}${error.status !== undefined ? ` HTTP ${error.status}` : ""}${error.code !== undefined ? ` code ${error.code}` : ""}); attempt ${this.errorCount}, next in ${Math.round(delay / 1000)} s`);
		this.setState({ kind: "error", message: error.message, since: this.errorSince, retryAt: now + delay });
	}

	private afterPoll(epoch: number): void {
		if (epoch !== this.epoch || this.disposed || this.listeners.size === 0) return;
		if (this.state.kind === "auth-error") return;
		const delay = this.pendingDelayMs ?? this.jittered(this.intervalMs);
		this.pendingDelayMs = undefined;
		this.schedule(delay);
	}

	private setState(next: ConnectionState): void {
		if (sameState(this.state, next)) return;
		this.state = next;
		this.notify();
	}

	/** Listener isolation: one throwing listener must not stop the others or the poller. */
	private notify(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener.callback();
			} catch (error) {
				this.log.error(`a listener threw; ignored: ${describeUnexpected(error)}`);
			}
		}
	}
}

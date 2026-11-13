/**
 * The history one visible action shows: what was asked, what came back, when to ask again.
 * SDK-free. One slot per action (key or dial), owned by its controller entry.
 *
 * Rules (docs/FOCUS-AND-HISTORY.md, section 4):
 *  - a request is made only while the action is visible: the slot exists between appear and
 *    disappear and goes quiet (`dispose`) afterwards, even for a request still in flight;
 *  - a successful result is kept for the service's cache time (10 minutes) before asking
 *    again, a failed one for one minute (the service additionally throttles per request),
 *    so repainting in a loop - the 60 s clock, a focus change back and forth - cannot
 *    become request traffic;
 *  - an old result stays on screen while a newer one is fetched (no flicker to "Loading");
 *  - the slot keeps a small LRU of results per request key, so going back to a previous
 *    focus shows its result at once instead of "Loading" (an expired one is shown while it
 *    is fetched again);
 *  - a result that belongs to a request the action has moved away from is kept for that
 *    request but does not repaint.
 */

import type { AdapterLogger } from "../adapter/logging.ts";
import type { ConnectionState, HistoryRequest, HistoryResult } from "../adapter/station/types.ts";
import { historyRequestKey } from "../render/history-view.ts";

/** Matches the service's cache (HISTORY_CACHE_TTL_MS in the adapter): asking sooner returns the same data. */
export const HISTORY_REFRESH_MS = 10 * 60_000;
export const HISTORY_RETRY_MS = 60_000;
/** Results remembered per slot: enough for the values of one sensor, small enough to stay cheap. */
export const HISTORY_SLOT_CACHE_SIZE = 8;

interface Cached {
	readonly result: HistoryResult;
	readonly receivedAt: number;
}

export interface HistorySlotDeps {
	fetch(request: HistoryRequest): Promise<HistoryResult> | undefined;
	now(): number;
	logger: AdapterLogger;
	/** A result arrived; the owner repaints. */
	onResult(): void;
}

export class HistorySlot {
	private readonly deps: HistorySlotDeps;
	private key: string | undefined;
	/** Insertion order = least recently used first. */
	private readonly cache = new Map<string, Cached>();
	private inflight: string | undefined;
	private disposed = false;

	constructor(deps: HistorySlotDeps) {
		this.deps = deps;
	}

	/**
	 * What to draw for `request` right now (undefined = not loaded yet), starting a fetch when
	 * there is nothing usable. `request` undefined = nothing to ask for (metric without history).
	 */
	view(request: HistoryRequest | undefined): HistoryResult | undefined {
		if (this.disposed) return undefined;
		if (!request) {
			this.key = undefined;
			return undefined;
		}
		const key = historyRequestKey(request);
		this.key = key;
		const cached = this.cache.get(key);
		if (cached) {
			// Touch: most recently used goes last.
			this.cache.delete(key);
			this.cache.set(key, cached);
		}
		const ttl = cached?.result.kind === "ok" ? HISTORY_REFRESH_MS : HISTORY_RETRY_MS;
		const usable = cached !== undefined && this.deps.now() - cached.receivedAt < ttl;
		if (!usable && this.inflight !== key) this.start(request, key);
		return cached?.result;
	}

	/** The owner went away: no more requests, no more repaints. */
	dispose(): void {
		this.disposed = true;
		this.key = undefined;
		this.cache.clear();
		this.inflight = undefined;
	}

	private start(request: HistoryRequest, key: string): void {
		let pending: Promise<HistoryResult> | undefined;
		try {
			pending = this.deps.fetch(request);
		} catch (err) {
			this.deps.logger.error(`history request failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (!pending) return;
		this.inflight = key;
		pending.then(
			(result) => this.arrived(key, result),
			(err) => {
				this.deps.logger.error(`history request failed: ${err instanceof Error ? err.message : String(err)}`);
				this.arrived(key, { kind: "error", request, message: "History could not be loaded.", reason: "transient" });
			},
		);
	}

	private arrived(key: string, result: HistoryResult): void {
		if (this.inflight === key) this.inflight = undefined;
		if (this.disposed) return;
		this.cache.delete(key);
		this.cache.set(key, { result, receivedAt: this.deps.now() });
		while (this.cache.size > HISTORY_SLOT_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
		if (this.key === key) this.deps.onResult();
	}
}

/** What the history key and the dial strip share: ask the service only for something that can be shown. */
export function isHistoryAskable(input: { hasSource: boolean; connection: ConnectionState; moduleFound: boolean }): boolean {
	return input.hasSource && input.moduleFound && input.connection.kind !== "no-credentials" && input.connection.kind !== "auth-error";
}

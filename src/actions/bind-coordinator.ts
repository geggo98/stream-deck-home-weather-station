/**
 * Per-action bind bookkeeping, extracted SDK-free so it can be unit-tested.
 *
 * An action's key/dial is (re-)bound on appear and on every settings change.
 * Two hazards fall out of that, both handled here and exercised by
 * tests/bind-coordinator.test.ts:
 *
 * 1. Stale continuations. A bind awaits things (the global settings load, a slow
 *    source). If the user changes settings meanwhile, a newer bind starts; the old
 *    one must NOT paint with state from the old configuration. Each bind captures a
 *    generation token (`nextGeneration`) and checks `isCurrent` after every await,
 *    so a superseded bind goes quiet.
 * 2. Typing floods. The Property Inspector persists text fields (for example the
 *    label) on roughly every keystroke, and re-binding each partial value would
 *    repaint for every intermediate state. Settings re-binds are debounced
 *    (`scheduleRebind`); only the last change within the window binds. onWillAppear
 *    still binds immediately.
 *
 * This class owns only the maps and timers; it imports nothing from the SDK so that
 * test files stay free of the SDK's log-rotation import side effect (see
 * docs/ARCHITECTURE.md, "Why the adapter is SDK-free").
 */

/** Default debounce for settings-triggered re-binds. */
export const REBIND_DEBOUNCE_MS = 400;

export class BindCoordinator {
	private readonly generations = new Map<string, number>();
	/**
	 * One counter for all actions, never reset: a token is unique for the life of the
	 * process, so forgetting an action's entry (see `invalidate`) can never let a stale
	 * bind of an old action match the first bind of a new action that reuses the id.
	 */
	private counter = 0;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly debounceMs: number;

	constructor(debounceMs: number = REBIND_DEBOUNCE_MS) {
		this.debounceMs = debounceMs;
	}

	/**
	 * Start a new bind generation for `actionId` and return its token. The
	 * caller holds the token and checks {@link isCurrent} after each await; once
	 * a newer bind (or {@link invalidate}) has bumped the counter, the old bind
	 * must stop touching the action.
	 */
	nextGeneration(actionId: string): number {
		const gen = ++this.counter;
		this.generations.set(actionId, gen);
		return gen;
	}

	/** True while `generation` is still the newest bind for `actionId`. */
	isCurrent(actionId: string, generation: number): boolean {
		return this.generations.get(actionId) === generation;
	}

	/**
	 * Debounce a settings-triggered re-bind: replace any pending timer for
	 * `actionId` so only the last change within the window runs. `onError`
	 * receives a rejection from `run` (the class stays SDK/logger-free).
	 */
	scheduleRebind(actionId: string, run: () => Promise<void>, onError: (err: unknown) => void): void {
		this.cancelRebind(actionId);
		const timer = setTimeout(() => {
			this.timers.delete(actionId);
			run().catch(onError);
		}, this.debounceMs);
		timer.unref?.();
		this.timers.set(actionId, timer);
	}

	/** Cancel a pending re-bind for `actionId` (no-op if none is queued). */
	cancelRebind(actionId: string): void {
		const timer = this.timers.get(actionId);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(actionId);
		}
	}

	/**
	 * Invalidate any in-flight bind and cancel a queued re-bind for `actionId`, and forget
	 * the id. Called when the action disappears: a bind whose wait is still pending finds
	 * `isCurrent` false (no entry) and goes quiet, and no debounced re-bind fires for a key
	 * that is no longer on screen. Forgetting keeps the map bounded by the actions that are
	 * on screen, not by every id that ever was.
	 */
	invalidate(actionId: string): void {
		this.generations.delete(actionId);
		this.cancelRebind(actionId);
	}

	/** Number of action ids currently tracked; exposed for the bounds test. */
	get trackedCount(): number {
		return this.generations.size;
	}
}

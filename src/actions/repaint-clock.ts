/**
 * One low-frequency timer that makes visible actions repaint even when no poll or status
 * change arrives.
 *
 * Why: what a key shows depends on the clock (a reading turns "stale" 25 minutes after it
 * was measured, and the age hint counts minutes), but repaints are otherwise driven only by
 * snapshot and status events. With a long poll interval or during a backoff a stopped sensor
 * would look fresh for up to one whole interval too long.
 *
 * Shared by the key and the dial controller (runtime.ts makes one). The timer exists only
 * while at least one listener is registered, i.e. while an action is visible, is unref'd so
 * it never keeps the process alive, and is cleared when the last listener leaves.
 * Repainting is cheap: painters de-duplicate, so a tick that changes nothing writes nothing.
 */

/** Tick interval. The age hint has minute resolution, so one minute is as fine as it gets. */
export const REPAINT_INTERVAL_MS = 60_000;

export class RepaintClock {
	private readonly listeners = new Set<() => void>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly intervalMs: number;

	constructor(intervalMs: number = REPAINT_INTERVAL_MS) {
		this.intervalMs = intervalMs;
	}

	/** Register a listener; returns the function that removes it. Idempotent to call twice. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		if (!this.timer) {
			this.timer = setInterval(() => this.tick(), this.intervalMs);
			this.timer.unref?.();
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0 && this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
		};
	}

	/** True while the timer exists; exposed for tests. */
	get running(): boolean {
		return this.timer !== undefined;
	}

	private tick(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// One failing painter must not stop the others or the timer.
			}
		}
	}
}

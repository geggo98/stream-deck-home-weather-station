/**
 * Auto rotate: ONE shared timer for all auto-rotate keys.
 *
 * The timer exists only while the state is "on" AND at least one auto-rotate key is
 * visible (registered). It is unref'd (never keeps the process alive) and cleared when the
 * last key disappears or the state goes off. The state is plugin-wide and off at start
 * unless a key with "start on" appears before anyone has toggled. With several keys the
 * shortest interval wins. SDK-free; the tick callback decides what "advance" means.
 */

import {
	AUTO_ROTATE_DEFAULT_SECONDS,
	AUTO_ROTATE_MAX_SECONDS,
	AUTO_ROTATE_MIN_SECONDS,
} from "./settings.ts";

export class AutoRotator {
	private readonly tick: () => void;
	private readonly keys = new Map<string, number>();
	private readonly listeners = new Set<() => void>();
	private on = false;
	/** True once the user toggled: "start on" then no longer applies. */
	private toggled = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private timerMs = 0;

	constructor(tick: () => void) {
		this.tick = tick;
	}

	/** A key became visible (or its settings changed). */
	register(id: string, seconds: number, startOn: boolean): void {
		const clamped = Number.isFinite(seconds)
			? Math.max(AUTO_ROTATE_MIN_SECONDS, Math.min(AUTO_ROTATE_MAX_SECONDS, seconds))
			: AUTO_ROTATE_DEFAULT_SECONDS;
		const known = this.keys.has(id);
		this.keys.set(id, clamped);
		if (!known && startOn && !this.toggled && !this.on) this.on = true;
		this.reconcile();
		if (!known) this.notify();
	}

	unregister(id: string): void {
		if (!this.keys.delete(id)) return;
		this.reconcile();
	}

	toggle(): void {
		this.toggled = true;
		this.on = !this.on;
		this.reconcile();
		this.notify();
	}

	get isOn(): boolean {
		return this.on;
	}

	/** Interval of the shared timer in seconds, undefined while there is no timer. */
	get intervalSeconds(): number | undefined {
		return this.timer ? this.timerMs / 1000 : undefined;
	}

	get running(): boolean {
		return this.timer !== undefined;
	}

	/** Whether the timer would keep the process alive; always false by construction. For tests. */
	get timerKeepsProcessAlive(): boolean | undefined {
		return this.timer?.hasRef?.();
	}

	/** Seconds the visible keys ask for (shortest wins). */
	get requestedSeconds(): number {
		return this.keys.size === 0 ? AUTO_ROTATE_DEFAULT_SECONDS : Math.min(...this.keys.values());
	}

	/** State changes (toggle, first key); returns the unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	dispose(): void {
		this.keys.clear();
		this.reconcile();
	}

	private reconcile(): void {
		const wanted = this.on && this.keys.size > 0 ? this.requestedSeconds * 1000 : 0;
		if (wanted === 0) {
			if (this.timer) clearInterval(this.timer);
			this.timer = undefined;
			this.timerMs = 0;
			return;
		}
		if (this.timer && this.timerMs === wanted) return;
		if (this.timer) clearInterval(this.timer);
		this.timerMs = wanted;
		this.timer = setInterval(() => {
			try {
				this.tick();
			} catch {
				// One failing tick must not stop the rotation.
			}
		}, wanted);
		this.timer.unref?.();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// see RepaintClock: one failing painter must not stop the others
			}
		}
	}
}

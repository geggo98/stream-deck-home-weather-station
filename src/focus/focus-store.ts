/**
 * The plugin-wide focus: held in memory, persisted into the global settings under `focus`
 * through the single-writer funnel (`updateGlobalSettings`), so it survives a restart.
 * SDK-free.
 *
 * Memory wins once something was set: the funnel's write is asynchronous and a settings
 * echo of an older value must not drag the focus backwards. Before the first `set` the
 * value comes from the cached global settings (the focus of the previous session).
 * A change notifies listeners synchronously (every follower repaints from the cache);
 * a failed write is logged and the value stays in memory, so navigation still works for
 * this session.
 *
 * `set(next, { persist: false })` is for the auto-rotate timer: it changes memory and
 * notifies the followers but writes nothing (a step every few seconds would be one write to
 * the Stream Deck app and one repaint of every action through the settings cache per step).
 * `flush()` persists the last value of such steps, once; the owner calls it when the
 * rotation stops.
 */

import type { AdapterLogger } from "../adapter/logging.ts";
import type { GlobalSettings } from "../pi-protocol.ts";
import { parseFocus, sameFocus, type Focus } from "./navigate.ts";

export interface FocusStoreDeps {
	getGlobal(): GlobalSettings;
	/** The settings write funnel (updateGlobalSettings). */
	update(patch: (current: GlobalSettings) => GlobalSettings | undefined): Promise<void>;
	logger: Pick<AdapterLogger, "warn">;
}

export class FocusStore {
	private readonly deps: FocusStoreDeps;
	private memory: Focus | undefined;
	/** A value that was set with `persist: false` and has not been written yet. */
	private unsaved = false;
	private readonly listeners = new Set<() => void>();

	constructor(deps: FocusStoreDeps) {
		this.deps = deps;
	}

	/** The stored focus; may be stale (see `resolveFocus`). */
	get(): Focus | undefined {
		return this.memory ?? parseFocus(this.deps.getGlobal().focus);
	}

	/** Returns false when nothing changed. `persist: false` keeps the value in memory only until `flush()`. */
	set(next: Focus, options: { persist?: boolean } = {}): boolean {
		if (sameFocus(this.get(), next)) return false;
		this.memory = next;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A repaint listener must not break navigation.
			}
		}
		if (options.persist === false) this.unsaved = true;
		else this.write(next);
		return true;
	}

	/** Writes the value of earlier `persist: false` steps, if there is one; a no-op otherwise. */
	flush(): void {
		if (!this.unsaved || !this.memory) return;
		this.write(this.memory);
	}

	private write(next: Focus): void {
		this.unsaved = false;
		this.deps
			.update((current) => (sameFocus(parseFocus(current.focus), next) ? undefined : { ...current, focus: { stationId: next.stationId, moduleId: next.moduleId, metric: next.metric } }))
			.catch((err) => this.deps.logger.warn(`focus not saved: ${err instanceof Error ? err.message : String(err)}`));
	}

	/** Called after every change; returns the unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

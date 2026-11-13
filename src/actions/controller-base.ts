/**
 * Lifecycle shared by key and dial controllers. SDK-free: the SDK action classes hand in
 * a small "surface" (what can be painted) and forward events, so everything here runs
 * under plain `node --test` with a fake surface and a fake `WeatherSource`.
 *
 * What it guarantees (patterns from a sibling plugin, adapted):
 *  - a BIND FUNNEL with generations: a bind that was superseded while it awaited goes
 *    quiet instead of painting stale state;
 *  - settings changes re-bind through a 400 ms debounce, because the Property Inspector
 *    persists text on nearly every keystroke;
 *  - ONE repaint closure (`paint`) shared by snapshot updates, status changes, global
 *    settings changes and a 60 s clock tick (repaint-clock.ts, exists only while an action is visible); it renders from the source's cache, never from a query;
 *  - image/title de-duplication, so a poll that changes nothing visible writes nothing;
 *  - cleanup on disappear, and a hard bound on tracked actions.
 */

import type { AdapterLogger } from "../adapter/logging.ts";
import type { HistoryRequest, HistoryResult, WeatherSource } from "../adapter/station/types.ts";
import type { FocusStore } from "../focus/focus-store.ts";
import type { ActionSettings } from "../focus/settings.ts";
import type { GlobalSettings } from "../pi-protocol.ts";
import { adoptionCandidate } from "../render/select.ts";
import type { DisplayMetricId } from "../render/metrics.ts";
import { BindCoordinator } from "./bind-coordinator.ts";
import { fireAndLog } from "./fire-and-log.ts";
import { forgetActionSettings, rememberActionDefaultMetric, rememberAllMetricsAction, rememberActionSettings, rememberHistoryAction } from "./global-settings.ts";
import { RepaintClock } from "./repaint-clock.ts";

export interface BaseSurface {
	readonly id: string;
	/** Persist this action's own settings (used for first-use adoption). */
	setSettings(settings: ActionSettings): Promise<void>;
}

export interface ControllerEnv {
	getSource(): WeatherSource | undefined;
	now(): number;
	logger: AdapterLogger;
	getGlobal(): GlobalSettings;
	/** Bounded wait for the global settings load; resolved immediately in tests. */
	waitForSettings(): Promise<void>;
	/** Subscribe to global settings changes (units); returns the unsubscribe function. */
	onGlobalChange(listener: () => void): () => void;
	/** Debounce of settings-triggered re-binds. Default 400 ms. */
	debounceMs?: number;
	/** Shared clock-driven repaint (staleness without a poll). Default: a private one. */
	clock?: RepaintClock;
	/** The plugin-wide focus; every controller repaints when it changes. */
	focus?: FocusStore;
	/** History for the history key and the dial strip; undefined result = no service. Only ever called for visible actions. */
	getHistory?(request: HistoryRequest): Promise<HistoryResult> | undefined;
}

export interface BaseEntry<S extends BaseSurface> {
	readonly surface: S;
	settings: ActionSettings;
	unsubscribe: (() => void) | undefined;
}

/** More actions than this on screen at once is not a real deck; refusing beats unbounded growth. */
export const MAX_CONTROLLED_ACTIONS = 512;

/** Fields whose change needs a re-bind/repaint; the rest of the settings object is ignored. */
export function settingsSignature(settings: ActionSettings): string {
	return JSON.stringify([
		settings.moduleKey ?? null,
		settings.metric ?? null,
		settings.unitSystem ?? null,
		settings.showTrend === true,
		settings.showMinMax === true,
		settings.bigText === true,
		settings.label ?? null,
		settings.followFocus ?? null,
		settings.alertAbove ?? null,
		settings.alertBelow ?? null,
		settings.historyWindow ?? null,
		settings.autoRotateSeconds ?? null,
		settings.autoRotateStartOn === true,
	]);
}

/** `X` is what the SDK class passes to `appear` beside the settings (a preset metric, a key kind); `undefined` when there is none. */
export abstract class ControllerBase<S extends BaseSurface, E extends BaseEntry<S>, X = undefined> {
	protected readonly entries = new Map<string, E>();
	protected readonly binds: BindCoordinator;
	private readonly offGlobal: () => void;
	private readonly offFocus: (() => void) | undefined;
	private readonly clock: RepaintClock;
	private offClock: (() => void) | undefined;

	protected readonly env: ControllerEnv;

	constructor(env: ControllerEnv) {
		this.env = env;
		this.binds = new BindCoordinator(env.debounceMs);
		this.offGlobal = env.onGlobalChange(() => this.repaintAll());
		this.offFocus = env.focus?.subscribe(() => this.repaintAll());
		this.clock = env.clock ?? new RepaintClock();
	}

	/** Build the per-action record. */
	protected abstract createEntry(surface: S, settings: ActionSettings, extra: X | undefined): E;
	/** Compute the view from the source's cache and write what changed. Must not throw for bad data. */
	protected abstract paint(entry: E): void;
	/** Drop the "already painted" memory so the next paint writes unconditionally. */
	protected abstract forgetPainted(entry: E): void;
	/** Release timers and other per-entry resources. */
	protected abstract release(entry: E): void;
	/** The metric whose availability decides adoption. */
	protected abstract adoptionMetric(entry: E): DisplayMetricId;
	/** The metric this action id presets (for the PI dropdown), if it has one. */
	protected presetMetric(_entry: E): DisplayMetricId | undefined {
		return undefined;
	}
	/** True for the action whose metric dropdown may only offer measurements that have a history. */
	protected offersHistoryMetricsOnly(_entry: E): boolean {
		return false;
	}
	/** True for the action whose metric dropdown offers every display metric, whatever sensor it points at now. */
	protected offersAllMetrics(_entry: E): boolean {
		return false;
	}
	/** True for an action whose module and metric come from the focus: it never adopts a module of its own. */
	protected followsFocus(_entry: E): boolean {
		return false;
	}
	/** Runs after a (re-)bind has subscribed and before the first repaint; for registrations that belong to "visible". */
	protected afterBind(_entry: E): void {}

	/** The action appeared (or the profile switched back to it): bind immediately. */
	appear(surface: S, settings: ActionSettings, extra?: X): Promise<void> {
		const existing = this.entries.get(surface.id);
		if (!existing && this.entries.size >= MAX_CONTROLLED_ACTIONS) {
			this.env.logger.warn(`too many actions (${this.entries.size}); ignoring one`);
			return Promise.resolve();
		}
		if (existing) this.dropEntry(existing);
		const entry = this.createEntry(surface, settings, extra);
		this.entries.set(surface.id, entry);
		this.offClock ??= this.clock.subscribe(() => this.repaintAll());
		rememberActionSettings(surface.id, settings);
		const preset = this.presetMetric(entry);
		if (preset) rememberActionDefaultMetric(surface.id, preset);
		if (this.offersHistoryMetricsOnly(entry)) rememberHistoryAction(surface.id);
		if (this.offersAllMetrics(entry)) rememberAllMetricsAction(surface.id);
		return this.bind(entry);
	}

	/** The PI (or we ourselves) changed the settings; re-bind only when something visible changed. */
	settingsChanged(actionId: string, incoming: ActionSettings): void {
		const entry = this.entries.get(actionId);
		if (!entry) return;
		const settings = this.reconcileSettings(entry, incoming);
		const changed = settingsSignature(settings) !== settingsSignature(entry.settings);
		entry.settings = settings;
		rememberActionSettings(actionId, settings);
		if (!changed) return;
		this.binds.scheduleRebind(
			actionId,
			() => this.bind(entry),
			(err) => this.env.logger.error(`rebind failed: ${err instanceof Error ? err.message : String(err)}`),
		);
	}

	/** Hook for subclasses that write settings themselves and must not undo their own echo. */
	protected reconcileSettings(_entry: E, incoming: ActionSettings): ActionSettings {
		return incoming;
	}

	disappear(actionId: string): void {
		const entry = this.entries.get(actionId);
		this.binds.invalidate(actionId);
		forgetActionSettings(actionId);
		if (entry) this.dropEntry(entry);
	}

	dispose(): void {
		for (const entry of [...this.entries.values()]) this.disappear(entry.surface.id);
		this.offGlobal();
		this.offFocus?.();
	}

	/** Number of tracked actions; exposed for tests of cleanup and bounds. */
	get size(): number {
		return this.entries.size;
	}

	/** Same bind funnel as the example pattern: generation first, then await, then check. */
	protected async bind(entry: E): Promise<void> {
		const id = entry.surface.id;
		const generation = this.binds.nextGeneration(id);
		const fresh = (): boolean => this.entries.get(id) === entry && this.binds.isCurrent(id, generation);
		entry.unsubscribe?.();
		entry.unsubscribe = undefined;
		this.forgetPainted(entry);

		await this.env.waitForSettings();
		if (!fresh()) return;

		const source = this.env.getSource();
		if (source) {
			const subscription = source.subscribe(() => {
				if (this.entries.get(id) === entry) this.repaint(entry);
			});
			entry.unsubscribe = () => subscription.unsubscribe();
		}
		this.afterBind(entry);
		this.repaint(entry);
	}

	protected repaint(entry: E): void {
		try {
			this.maybeAdopt(entry);
			this.paint(entry);
		} catch (err) {
			this.env.logger.error(`repaint failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	protected repaintAll(): void {
		for (const entry of this.entries.values()) this.repaint(entry);
	}

	/**
	 * First use: a freshly dropped action has no module yet and adopts one into ITS OWN
	 * settings (never into global settings, never into another action). A deliberately
	 * cleared choice is `""`, not `undefined`, and stays empty.
	 */
	private maybeAdopt(entry: E): void {
		if (entry.settings.moduleKey !== undefined || this.followsFocus(entry)) return;
		const snapshot = this.env.getSource()?.getSnapshot();
		if (!snapshot) return;
		const candidate = adoptionCandidate(snapshot, this.adoptionMetric(entry));
		if (!candidate) return;
		entry.settings = { ...entry.settings, moduleKey: candidate.key };
		rememberActionSettings(entry.surface.id, entry.settings);
		fireAndLog(entry.surface.setSettings(entry.settings), this.env.logger, "setSettings");
	}

	private dropEntry(entry: E): void {
		entry.unsubscribe?.();
		entry.unsubscribe = undefined;
		this.release(entry);
		if (this.entries.get(entry.surface.id) === entry) this.entries.delete(entry.surface.id);
		if (this.entries.size === 0) {
			this.offClock?.();
			this.offClock = undefined;
		}
	}
}

/**
 * The plugin-wide settings (Stream Deck "global settings"): cache, load gate and the one
 * write funnel. SDK-free; `plugin.ts` injects the writer and is the ONLY caller of
 * `setGlobalSettings` (tests/global-settings.test.ts greps for that).
 *
 * Why a funnel (lessons from the sibling project this pattern comes from, two real
 * data-loss bugs there):
 *  - Writing before the initial load persists a snapshot with every other key missing,
 *    because the cache every writer merges over is empty until the load lands (it lands
 *    AFTER connect(), i.e. after the first actions have already appeared). Hence the gate.
 *  - Writing over the cache without putting the result back into it leaves the next
 *    writer merging over a superseded snapshot. Stream Deck does not echo a plugin's own
 *    `setGlobalSettings` back as `didReceiveGlobalSettings`, so nothing else repairs it.
 *
 * No secrets live here: global settings are plain JSON in the user's profile and are
 * dumped into the log at TRACE level. Credentials have their own 0600 file (see the
 * adapter).
 */

import type { GlobalSettings, MeasurementSettings } from "../pi-protocol.ts";

let cached: GlobalSettings = {};
const listeners = new Set<() => void>();

export function getCachedGlobalSettings(): GlobalSettings {
	return cached;
}

/** Replace the cache (initial load, `didReceiveGlobalSettings`, funnel write) and tell listeners. */
export function setCachedGlobalSettings(settings: GlobalSettings | undefined): void {
	cached = settings ?? {};
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// A repaint listener must never break the settings path.
		}
	}
}

/** Called whenever the cache changes; returns the unsubscribe function. */
export function onGlobalSettingsChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

let markLoaded: () => void = () => {};
let loaded = false;
const loadedPromise = new Promise<void>((resolve) => {
	markLoaded = resolve;
});

/**
 * Open the write gate. Called once by plugin.ts, and deliberately only after a
 * SUCCESSFUL load: if the settings could not be read we do not know what is in them, so
 * overwriting them is worse than not remembering anything this session.
 */
export function markGlobalSettingsLoaded(): void {
	loaded = true;
	markLoaded();
}

export function areGlobalSettingsLoaded(): boolean {
	return loaded;
}

/** How long a bind may wait for the load before carrying on without it. */
export const GLOBAL_SETTINGS_WAIT_MS = 2000;

/**
 * Bounded wait for the load, for readers that would otherwise decide on an empty cache
 * (units, for example). Capped: a load that never completes must cost the global values,
 * not the bind.
 */
export function waitForGlobalSettings(timeoutMs: number = GLOBAL_SETTINGS_WAIT_MS): Promise<void> {
	return Promise.race([
		loadedPromise,
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		}),
	]);
}

export type GlobalSettingsWriter = (settings: GlobalSettings) => Promise<void>;

let writer: GlobalSettingsWriter | undefined;
export function setGlobalSettingsWriter(write: GlobalSettingsWriter | undefined): void {
	writer = write;
}

let writeQueue: Promise<void> = Promise.resolve();

/**
 * The only way to write the global settings. Patches are applied to the live cache,
 * serialised against each other, and the cache is updated BEFORE the round trip so a
 * queued patch merges over the new values even while the write is in flight. A patch
 * returning `undefined` skips the write. A failed write leaves the new values in the
 * cache on purpose: the next successful write carries them, so a transient failure
 * self-heals instead of resurrecting old data.
 */
export function updateGlobalSettings(
	patch: (current: GlobalSettings) => GlobalSettings | undefined,
	waitMs: number = GLOBAL_SETTINGS_WAIT_MS,
): Promise<void> {
	const run = writeQueue.then(async () => {
		await waitForGlobalSettings(waitMs);
		if (!loaded) throw new Error("global settings were never loaded - refusing to overwrite them");
		if (!writer) throw new Error("no global-settings writer injected");
		const next = patch(cached);
		if (next === undefined) return;
		setCachedGlobalSettings(next);
		await writer(next);
	});
	writeQueue = run.then(
		() => {},
		() => {},
	);
	return run;
}

// --- validated accessors -----------------------------------------------------

/** Poll interval bounds in seconds; the adapter clamps again, this only keeps junk out of settings. */
export const MIN_POLL_SECONDS = 60;
export const MAX_POLL_SECONDS = 3600;

/** The configured poll interval, or undefined when unset or not a sensible number. */
export function pollIntervalOf(gs: GlobalSettings): number | undefined {
	const v = gs.pollIntervalSeconds;
	if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
	return Math.max(MIN_POLL_SECONDS, Math.min(MAX_POLL_SECONDS, Math.round(v)));
}

export function unitSystemOf(gs: GlobalSettings): "account" | "metric" | "imperial" {
	const v = gs.unitSystem;
	return v === "metric" || v === "imperial" ? v : "account";
}

// --- per-action settings memory ---------------------------------------------

/**
 * The settings each action was last seen with, by action id. A PI datasource request
 * needs the asking action's module, and `action.getSettings()` is a WebSocket round trip
 * whose reply is also delivered to the action's own handler, so merely opening a PI
 * would re-enter onDidReceiveSettings. Actions record what they already have instead.
 */
const actionSettings = new Map<string, MeasurementSettings>();
/** Bound on every map keyed by externally supplied ids. */
export const MAX_TRACKED_ACTION_SETTINGS = 512;

export function rememberActionSettings(actionId: string, settings: MeasurementSettings): void {
	if (!actionSettings.has(actionId) && actionSettings.size >= MAX_TRACKED_ACTION_SETTINGS) {
		const oldest = actionSettings.keys().next().value;
		if (oldest !== undefined) actionSettings.delete(oldest);
	}
	actionSettings.set(actionId, settings);
}

export function getRememberedActionSettings(actionId: string): MeasurementSettings | undefined {
	return actionSettings.get(actionId);
}

export function forgetActionSettings(actionId: string): void {
	actionSettings.delete(actionId);
	actionDefaultMetric.delete(actionId);
}

/**
 * The metric each action id presets (the humidity key presets "humidity"). The Property
 * Inspector's metric dropdown can then preselect it while the action's own `metric` setting
 * is still empty. Bounded like the settings memory.
 */
const actionDefaultMetric = new Map<string, string>();

export function rememberActionDefaultMetric(actionId: string, metric: string): void {
	if (!actionDefaultMetric.has(actionId) && actionDefaultMetric.size >= MAX_TRACKED_ACTION_SETTINGS) {
		const oldest = actionDefaultMetric.keys().next().value;
		if (oldest !== undefined) actionDefaultMetric.delete(oldest);
	}
	actionDefaultMetric.set(actionId, metric);
}

export function getRememberedDefaultMetric(actionId: string): string | undefined {
	return actionDefaultMetric.get(actionId);
}

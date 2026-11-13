/**
 * Behaviour of the keypad actions (temperature, humidity, ...), SDK-free.
 *
 * One controller serves every keypad action; the SDK classes differ only in the default
 * metric they pass. A key shows what `buildKeyView` computes from the source's cache.
 * Every image goes out as a base64 data URI, never as a raw SVG string.
 */

import { isDisplayMetricId, METRICS, type DisplayMetricId } from "../render/metrics.ts";
import { svgToDataUri } from "../render/data-uri.ts";
import { buildKeyView } from "../render/key-view.ts";
import type { AdapterLogger } from "../adapter/logging.ts";
import type { ConnectionState } from "../adapter/station/types.ts";
import { displayMetricOf, focusModuleKey, resolveFocus } from "../focus/navigate.ts";
import { followFocusOf, type ActionSettings } from "../focus/settings.ts";
import { ControllerBase, type BaseEntry, type BaseSurface, type ControllerEnv } from "./controller-base.ts";
import { fireAndLog } from "./fire-and-log.ts";

export interface KeySurface extends BaseSurface {
	setImage(image: string | undefined): Promise<void>;
	/** `undefined` = no text; Stream Deck then shows the manifest title. Ignored by Stream Deck while the user has typed a custom title. */
	setTitle(title: string | undefined): Promise<void>;
	/** Flash the key's alert (a yellow triangle): "nothing happened because there was nothing to do". */
	showAlert?(): Promise<void>;
}

/** The fields a face writer needs; keys of every kind share them. */
export interface FaceEntry {
	readonly surface: KeySurface;
	paintedImage: string | undefined;
	paintedTitle: string | undefined;
	/** False until the first write, so "no title" still gets written once. */
	titlePainted: boolean;
}

/**
 * Write a face (raw SVG + title) to a key, skipping what is already there. A rejected
 * write must not count as painted, or the key would keep the old face until the content
 * happens to change; forgetting makes the next tick write again.
 */
export function writeKeyFace(entry: FaceEntry, face: { svg: string; title: string | undefined }, logger: AdapterLogger): void {
	const image = svgToDataUri(face.svg);
	if (image !== entry.paintedImage) {
		entry.paintedImage = image;
		fireAndLog(entry.surface.setImage(image), logger, "setImage", () => {
			if (entry.paintedImage === image) entry.paintedImage = undefined;
		});
	}
	if (!entry.titlePainted || face.title !== entry.paintedTitle) {
		entry.titlePainted = true;
		entry.paintedTitle = face.title;
		const title = face.title;
		fireAndLog(entry.surface.setTitle(title), logger, "setTitle", () => {
			if (entry.paintedTitle === title) entry.titlePainted = false;
		});
	}
}

/** Ask the source for a refresh; coalesced and rate-limited there (at most one real request per minute). */
export function requestRefresh(source: { refresh(): Promise<void> } | undefined, logger: AdapterLogger): Promise<void> {
	if (!source) return Promise.resolve();
	try {
		return source.refresh().catch((err) => {
			logger.error(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	} catch (err) {
		logger.error(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
		return Promise.resolve();
	}
}

/** How long today's min/max replace the value after a press. */
export const OVERLAY_MS = 6000;

interface KeyEntry extends BaseEntry<KeySurface>, FaceEntry {
	readonly defaultMetric: DisplayMetricId;
	/** What the action id forces, whatever the settings say: "all" (focus display), "sensor" (sensor focus) or "none" (settings decide). */
	readonly follow: FollowMode;
	overlayUntil: number;
	overlayTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface KeyControllerEnv extends ControllerEnv {
	overlayMs?: number;
}

const LOADING: ConnectionState = { kind: "loading" };

/**
 * How a key follows the plugin-wide focus: "none" = not at all, "sensor" = station and sensor but
 * its own metric, "all" = station, sensor and metric.
 */
export type FollowMode = "none" | "sensor" | "all";

/**
 * What an action id passes to `appear`: the metric it shows by default, or `{ metric, follow }`.
 * `follow: true` means "all" (the focus display); "sensor" is the sensor focus.
 */
export type KeyExtra = DisplayMetricId | { readonly metric: DisplayMetricId; readonly follow?: boolean | FollowMode };

function followModeOf(extra: KeyExtra | undefined): FollowMode {
	if (typeof extra !== "object") return "none";
	if (extra.follow === true || extra.follow === "all") return "all";
	return extra.follow === "sensor" ? "sensor" : "none";
}

export class KeyController extends ControllerBase<KeySurface, KeyEntry, KeyExtra> {
	private readonly overlayMs: number;

	constructor(env: KeyControllerEnv) {
		super(env);
		this.overlayMs = env.overlayMs ?? OVERLAY_MS;
	}

	/**
	 * `extra` is what this action id shows when the PI has not picked another metric, or
	 * `{ metric, follow: true }` for the focus display (follows the focus completely) or
	 * `{ metric, follow: "sensor" }` for the sensor focus (follows station and sensor only).
	 */
	override appear(surface: KeySurface, settings: ActionSettings, extra?: KeyExtra): Promise<void> {
		return super.appear(surface, settings, extra);
	}

	protected createEntry(surface: KeySurface, settings: ActionSettings, extra: KeyExtra | undefined): KeyEntry {
		const metric = typeof extra === "object" ? extra.metric : extra;
		return {
			surface,
			settings,
			unsubscribe: undefined,
			defaultMetric: metric !== undefined && isDisplayMetricId(metric) ? metric : "temperature",
			follow: followModeOf(extra),
			paintedImage: undefined,
			paintedTitle: undefined,
			titlePainted: false,
			overlayUntil: 0,
			overlayTimer: undefined,
		};
	}

	protected override followsFocus(entry: KeyEntry): boolean {
		return entry.follow !== "none" || followFocusOf(entry.settings, false);
	}

	/**
	 * What the key shows.
	 *
	 * - A fixed measurement key (CO2, humidity ...) with "Follow focus" ticked follows the focus's
	 *   STATION AND SENSOR but keeps its own metric: a CO2 key must stay a CO2 key when the focus
	 *   moves to another sensor (it shows "No data" where that sensor has no CO2). Its alert
	 *   thresholds therefore stay valid (same metric, same unit) and apply.
	 * - The focus display (follow "all") follows everything: sensor AND metric. Alert thresholds
	 *   are ignored there: they are typed in the unit of one metric, and the displayed metric (and
	 *   unit) changes whenever the focus moves. The values stay in the settings.
	 *
	 * - The sensor focus (follow "sensor") behaves like such a key, but always, not only when ticked:
	 *   a stored moduleKey is overridden by the focus's, and the metric comes from its own settings.
	 *
	 * Before the first snapshot a following key falls back to its own (loading) state.
	 */
	private effective(entry: KeyEntry): { metric: DisplayMetricId; settings: ActionSettings } {
		const own = { metric: this.ownMetric(entry), settings: entry.settings };
		if (!this.followsFocus(entry)) return own;
		const { alertAbove: _above, alertBelow: _below, ...withoutAlerts } = entry.settings;
		const fullFollow = entry.follow === "all";
		const fallback = fullFollow ? { metric: own.metric, settings: withoutAlerts } : own;
		if (!this.env.focus) return fallback;
		const focus = resolveFocus(this.env.getSource()?.getSnapshot(), this.env.focus.get());
		if (!focus) return fallback;
		const moduleKey = focusModuleKey(focus);
		if (!fullFollow) return { metric: own.metric, settings: { ...entry.settings, moduleKey } };
		const metric = displayMetricOf(focus.metric);
		if (!metric) return fallback;
		return { metric, settings: { ...withoutAlerts, moduleKey } };
	}

	private ownMetric(entry: KeyEntry): DisplayMetricId {
		return isDisplayMetricId(entry.settings.metric) ? entry.settings.metric : entry.defaultMetric;
	}

	private metricOf(entry: KeyEntry): DisplayMetricId {
		return this.effective(entry).metric;
	}

	protected override offersAllMetrics(entry: KeyEntry): boolean {
		return entry.follow === "sensor";
	}

	protected override presetMetric(entry: KeyEntry): DisplayMetricId {
		return entry.defaultMetric;
	}

	protected adoptionMetric(entry: KeyEntry): DisplayMetricId {
		return this.ownMetric(entry);
	}

	protected forgetPainted(entry: KeyEntry): void {
		entry.paintedImage = undefined;
		entry.paintedTitle = undefined;
		entry.titlePainted = false;
	}

	protected release(entry: KeyEntry): void {
		if (entry.overlayTimer) clearTimeout(entry.overlayTimer);
		entry.overlayTimer = undefined;
	}

	protected paint(entry: KeyEntry): void {
		const source = this.env.getSource();
		const now = this.env.now();
		const { metric, settings } = this.effective(entry);
		const view = buildKeyView({
			metric,
			settings,
			global: this.env.getGlobal(),
			hasSource: source !== undefined,
			connection: source?.getConnectionState() ?? LOADING,
			snapshot: source?.getSnapshot(),
			now,
			overlay: entry.overlayUntil > now,
		});
		writeKeyFace(entry, view, this.env.logger);
	}

	/**
	 * A press asks the service for a refresh. The service joins a poll that is already
	 * running and otherwise makes a real request at most once a minute (and none while it is
	 * backing off or signed out), so pressing cannot flood the API, but a press CAN cause one
	 * request. For metrics that have extremes it also shows them for a few seconds.
	 * The overlay is only a timestamp: the normal render consults it, so it expires by itself
	 * and "status beats metadata" holds (an unreachable module still says "No signal").
	 */
	press(actionId: string): void {
		const entry = this.entries.get(actionId);
		if (!entry) return;
		void requestRefresh(this.env.getSource(), this.env.logger);
		if (METRICS[this.metricOf(entry)].min === undefined) return;
		if (entry.overlayTimer) clearTimeout(entry.overlayTimer);
		entry.overlayUntil = this.env.now() + this.overlayMs;
		entry.overlayTimer = setTimeout(() => {
			entry.overlayTimer = undefined;
			if (this.entries.get(actionId) === entry) this.repaint(entry);
		}, this.overlayMs + 1);
		entry.overlayTimer.unref?.();
		this.repaint(entry);
	}
}

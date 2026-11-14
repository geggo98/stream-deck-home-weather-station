/**
 * Behaviour of the three dial actions (Stream Deck + encoder), SDK-free. One controller serves
 * all three; the SDK class passes the MODE through `appear`:
 *
 *  - "sensor" (Sensor Dial):  rotate = next/previous sensor (module of the station, chosen by
 *                             the dial's OWN metric), rotate pushed = next/previous station,
 *                             push = reload. Shows the metric of its own settings.
 *  - "value"  (Value Dial):   rotate = next/previous value, rotate pushed = next/previous
 *                             sensor, push = reload.
 *  - "custom" (Custom Dial):  the three gestures come from the settings dialRotate,
 *                             dialPressRotate, dialPush ("value" | "sensor" | "station" |
 *                             "reload" | "none"); defaults: value, station, sensor.
 *  - touch tap:               reload: ask the service for the newest cloud data (a running poll is
 *                             joined, else at most one real request per minute; it cannot make the
 *                             station measure)
 *  - touch hold:              cycle the strip: value -> today's min/max (where there are any) ->
 *                             mini history (where the value has one) -> value
 *
 * THE SWITCH (setting `followFocus`, default true), the same on all three:
 *  - on: the dial shows what the plugin-wide focus points at and navigation moves the focus, so
 *    every follower repaints. The Sensor Dial follows station and sensor of the focus but keeps
 *    its own metric (like Sensor Focus); the other two follow sensor and value (like Focus Display).
 *  - off ("only this dial"): the dial keeps its own module and value in its own settings, written
 *    after a short quiet period so fast rotation does not hammer the settings store, and never
 *    touches the focus.
 * A dial without a focus store behaves as if the switch were off.
 */

import type { ConnectionState, HistoryWindow, StationSnapshot } from "../adapter/station/types.ts";
import {
	displayMetricOf,
	focusModuleKey,
	metricKeyOf,
	nextMetric,
	nextModule,
	nextModuleFor,
	nextStation,
	resolveFocus,
	type Direction,
	type Focus,
	type NavResult,
} from "../focus/navigate.ts";
import { dialGestureOf, followFocusOf, historyWindowOf, type ActionSettings } from "../focus/settings.ts";
import { BUILT_IN_LAYOUT, buildDialFeedback, buildHistoryStrip, HISTORY_LAYOUT, type DialFeedbackPayload, type HistoryStripPayload } from "../render/dial-feedback.ts";
import { historyRequestFor } from "../render/history-view.ts";
import { HISTORY_METRIC, isDisplayMetricId, metricsReportedBy, METRICS, type DisplayMetricId } from "../render/metrics.ts";
import { adoptionCandidate, findModule, makeModuleKey } from "../render/select.ts";
import type { DialGesture } from "../pi-protocol.ts";
import { ControllerBase, type BaseEntry, type BaseSurface, type ControllerEnv } from "./controller-base.ts";
import { fireAndLog } from "./fire-and-log.ts";
import { HistorySlot, isHistoryAskable } from "./history-slot.ts";
import { requestRefresh } from "./key-controller.ts";

export interface DialSurface extends BaseSurface {
	setFeedback(payload: DialFeedbackPayload | HistoryStripPayload): Promise<void>;
	/** Switch the strip between the built-in layout and the history layout. */
	setFeedbackLayout?(layout: string): Promise<void>;
}

/** Quiet period before a rotated-to face is persisted into the action's settings. */
export const PERSIST_METRIC_MS = 800;

/** One rotation event can carry several ticks; bound the work a runaway value could cause. */
const MAX_TICKS_PER_EVENT = 12;

type StripView = "value" | "minmax" | "history";

/** Which of the three dial actions an entry is; passed through `appear` by the SDK class. */
export type DialMode = "sensor" | "value" | "custom";

/** What each gesture does. */
interface GestureMap {
	readonly rotate: DialGesture;
	readonly pressRotate: DialGesture;
	readonly push: DialGesture;
}

const SENSOR_DIAL: GestureMap = { rotate: "sensor", pressRotate: "station", push: "reload" };
const VALUE_DIAL: GestureMap = { rotate: "value", pressRotate: "sensor", push: "reload" };
/** The Custom Dial's defaults are what the one and only dial did before there were three. */
const CUSTOM_DEFAULTS: GestureMap = { rotate: "value", pressRotate: "station", push: "sensor" };

/** The gesture mapping of a mode; the Custom Dial reads its settings, the others are fixed. */
export function gesturesOf(mode: DialMode, settings: ActionSettings): GestureMap {
	if (mode === "sensor") return SENSOR_DIAL;
	if (mode === "value") return VALUE_DIAL;
	return {
		rotate: dialGestureOf(settings.dialRotate, CUSTOM_DEFAULTS.rotate),
		pressRotate: dialGestureOf(settings.dialPressRotate, CUSTOM_DEFAULTS.pressRotate),
		push: dialGestureOf(settings.dialPush, CUSTOM_DEFAULTS.push),
	};
}

interface DialEntry extends BaseEntry<DialSurface> {
	readonly mode: DialMode;
	/** Pinned face; undefined = first measurement the module reports. Unused while following. */
	metric: DisplayMetricId | undefined;
	view: StripView;
	painted: string | undefined;
	/** The layout we last asked the strip to use; undefined until the first paint. */
	layout: string | undefined;
	persistTimer: ReturnType<typeof setTimeout> | undefined;
	/** The face we last wrote ourselves; lets us recognise our own settings echo. */
	lastWrittenMetric: DisplayMetricId | undefined;
	slot: HistorySlot;
	pressed: boolean;
	rotatedWhilePressed: boolean;
}

export interface DialControllerEnv extends ControllerEnv {
	persistMs?: number;
}

const LOADING: ConnectionState = { kind: "loading" };
const FALLBACK_METRIC: DisplayMetricId = "temperature";

export class DialController extends ControllerBase<DialSurface, DialEntry, DialMode> {
	private readonly persistMs: number;

	constructor(env: DialControllerEnv) {
		super(env);
		this.persistMs = env.persistMs ?? PERSIST_METRIC_MS;
	}

	/** `extra` is the mode of the action; without one the dial is the Custom Dial. */
	override appear(surface: DialSurface, settings: ActionSettings, extra?: DialMode): Promise<void> {
		return super.appear(surface, settings, extra);
	}

	protected createEntry(surface: DialSurface, settings: ActionSettings, extra: DialMode | undefined): DialEntry {
		// The slot's callback names the entry it belongs to; it only runs later, after `entry` exists.
		const slot = new HistorySlot({
			fetch: (request) => this.env.getHistory?.(request),
			now: () => this.env.now(),
			logger: this.env.logger,
			onResult: () => {
				if (this.entries.get(surface.id) === entry) this.repaint(entry);
			},
		});
		const entry: DialEntry = {
			mode: extra ?? "custom",
			surface,
			settings,
			unsubscribe: undefined,
			metric: isDisplayMetricId(settings.metric) ? settings.metric : undefined,
			view: "value",
			painted: undefined,
			layout: undefined,
			persistTimer: undefined,
			lastWrittenMetric: undefined,
			slot,
			pressed: false,
			rotatedWhilePressed: false,
		};
		return entry;
	}

	private follows(entry: DialEntry): boolean {
		return followFocusOf(entry.settings, true) && this.env.focus !== undefined;
	}

	protected override followsFocus(entry: DialEntry): boolean {
		return this.follows(entry);
	}

	/** What the module the pinned dial reads reports: its own choice, else the one adoption would pick. */
	private reportedMetrics(entry: DialEntry): DisplayMetricId[] {
		return this.reportedMetricsFor(entry.settings.moduleKey);
	}

	private reportedMetricsFor(moduleKey: string | undefined): DisplayMetricId[] {
		const snapshot = this.env.getSource()?.getSnapshot();
		if (!snapshot) return [];
		const selected = moduleKey === undefined ? adoptionCandidate(snapshot, FALLBACK_METRIC) : findModule(snapshot, moduleKey);
		return selected ? metricsReportedBy(selected.module.values) : [];
	}

	/** The Sensor Dial's metric is a setting with a default; the others start on what the module reports first. */
	private pinnedMetric(entry: DialEntry): DisplayMetricId {
		if (entry.mode === "sensor") return entry.metric ?? FALLBACK_METRIC;
		return entry.metric ?? this.reportedMetrics(entry)[0] ?? FALLBACK_METRIC;
	}

	protected override offersAllMetrics(entry: DialEntry): boolean {
		return entry.mode === "sensor";
	}

	protected override presetMetric(entry: DialEntry): DisplayMetricId | undefined {
		return entry.mode === "sensor" ? FALLBACK_METRIC : undefined;
	}

	/** What the dial shows now: the focus while following, its own choice otherwise. */
	private effective(entry: DialEntry): { metric: DisplayMetricId; settings: ActionSettings } {
		const own = { metric: this.pinnedMetric(entry), settings: entry.settings };
		if (!this.follows(entry)) return own;
		const focus = resolveFocus(this.env.getSource()?.getSnapshot(), this.env.focus?.get());
		if (!focus) return own;
		// The Sensor Dial follows station and sensor only; its metric stays its own.
		if (entry.mode === "sensor") return { metric: own.metric, settings: { ...entry.settings, moduleKey: focusModuleKey(focus) } };
		const metric = displayMetricOf(focus.metric);
		if (!metric) return own;
		return { metric, settings: { ...entry.settings, moduleKey: focusModuleKey(focus) } };
	}

	/** The focus navigation starts from: the real one, or the pinned dial's own position. */
	private currentFocus(entry: DialEntry): Focus | undefined {
		const snapshot = this.env.getSource()?.getSnapshot();
		if (!snapshot) return undefined;
		if (this.follows(entry)) return resolveFocus(snapshot, this.env.focus?.get());
		const { moduleKey } = entry.settings;
		const selected = moduleKey === undefined ? adoptionCandidate(snapshot, FALLBACK_METRIC) : findModule(snapshot, moduleKey);
		if (!selected) return undefined;
		return { stationId: selected.station.id, moduleId: selected.module.id, metric: metricKeyOf(this.pinnedMetric(entry)) };
	}

	protected adoptionMetric(entry: DialEntry): DisplayMetricId {
		return entry.mode === "sensor" ? this.pinnedMetric(entry) : FALLBACK_METRIC;
	}

	protected forgetPainted(entry: DialEntry): void {
		entry.painted = undefined;
		// Do not assume the strip kept its layout across a re-bind.
		entry.layout = undefined;
	}

	protected release(entry: DialEntry): void {
		if (entry.persistTimer) clearTimeout(entry.persistTimer);
		entry.persistTimer = undefined;
		entry.slot.dispose();
	}

	/** A settings echo of our own write must not drag the face back to an older value. */
	protected override reconcileSettings(entry: DialEntry, incoming: ActionSettings): ActionSettings {
		if (entry.mode === "sensor") {
			// The metric is a plain setting here: the PI wins, and a module switch never resets it
			// (a module without that metric shows "No data", and the dial only visits modules that have it).
			entry.metric = isDisplayMetricId(incoming.metric) ? incoming.metric : undefined;
			return incoming;
		}
		if (incoming.metric !== undefined && incoming.metric === entry.lastWrittenMetric) {
			return { ...incoming, metric: entry.metric };
		}
		// A different value came from the PI: it wins ...
		entry.metric = isDisplayMetricId(incoming.metric) ? incoming.metric : undefined;
		// ... except that a module switch must not strand the dial on a face the NEW module
		// does not report (the dial PI has no metric dropdown to correct it, and rotating
		// from a face that is not in the list would skip the first measurement).
		if (incoming.moduleKey !== entry.settings.moduleKey && entry.metric !== undefined) {
			const reported = this.reportedMetricsFor(incoming.moduleKey);
			if (reported.length > 0 && !reported.includes(entry.metric)) {
				entry.metric = undefined;
				entry.lastWrittenMetric = undefined;
				const { metric: _dropped, ...rest } = incoming;
				const reset: ActionSettings = rest;
				// Persist the reset too, so the next appear does not bring the stale face back.
				this.schedulePersist(entry);
				return reset;
			}
		}
		return incoming;
	}

	private wantedView(entry: DialEntry, metric: DisplayMetricId): StripView {
		if (entry.view === "history" && !HISTORY_METRIC[metric]) return "value";
		return entry.view;
	}

	protected paint(entry: DialEntry): void {
		const source = this.env.getSource();
		const { metric, settings } = this.effective(entry);
		const common = {
			metric,
			settings,
			global: this.env.getGlobal(),
			hasSource: source !== undefined,
			connection: source?.getConnectionState() ?? LOADING,
			snapshot: source?.getSnapshot(),
			now: this.env.now(),
		};
		const view = this.wantedView(entry, metric);
		let layout = BUILT_IN_LAYOUT;
		let payload: DialFeedbackPayload | HistoryStripPayload;
		if (view === "history") {
			layout = HISTORY_LAYOUT;
			const snapshot = common.snapshot;
			const selected = snapshot && settings.moduleKey !== undefined ? findModule(snapshot, settings.moduleKey) : undefined;
			const window: HistoryWindow = historyWindowOf(entry.settings);
			const askable = isHistoryAskable({ hasSource: source !== undefined, connection: common.connection, moduleFound: selected !== undefined });
			const request = askable && selected ? historyRequestFor(selected, metric, window) : undefined;
			payload = buildHistoryStrip({ ...common, window, result: entry.slot.view(request) });
		} else {
			payload = buildDialFeedback({ ...common, showMinMax: view === "minmax" });
		}
		const serialised = JSON.stringify([layout, payload]);
		if (serialised === entry.painted) return;
		entry.painted = serialised;
		const forget = (): void => {
			if (entry.painted === serialised) entry.painted = undefined;
		};
		if (entry.layout !== layout) {
			const switched = entry.surface.setFeedbackLayout?.(layout);
			entry.layout = layout;
			if (switched) {
				fireAndLog(switched, this.env.logger, "setFeedbackLayout", () => {
					if (entry.layout === layout) entry.layout = undefined;
					forget();
				});
			}
		}
		fireAndLog(entry.surface.setFeedback(payload), this.env.logger, "setFeedback", forget);
	}

	/** Make a navigation result the new position: the focus while following, the dial's own settings otherwise. */
	private apply(entry: DialEntry, focus: Focus): void {
		entry.view = "value";
		if (this.follows(entry)) {
			this.env.focus!.set(focus);
			// The store repaints every follower; a change of the dial's own view needs its own repaint.
			this.repaint(entry);
			return;
		}
		const moduleKey = makeModuleKey(focus.stationId, focus.moduleId);
		if (entry.mode === "sensor") {
			// Only the module moves; the metric is the dial's setting.
			entry.settings = { ...entry.settings, moduleKey };
		} else {
			const metric = displayMetricOf(focus.metric);
			entry.metric = metric;
			entry.settings = { ...entry.settings, moduleKey, metric };
		}
		this.schedulePersist(entry);
		this.repaint(entry);
	}

	/** One step of a navigation gesture from `focus`; undefined = nothing to move to. */
	private stepFrom(entry: DialEntry, snapshot: StationSnapshot, focus: Focus, gesture: DialGesture, dir: Direction): Focus | undefined {
		let result: NavResult | undefined;
		if (gesture === "value") result = nextMetric(snapshot, focus, dir);
		else if (gesture === "station") result = nextStation(snapshot, focus, dir);
		else if (gesture === "sensor") {
			// The Sensor Dial moves by its OWN metric (so a rain dial reaches the rain module);
			// the other dials by the value they show.
			result = entry.mode === "sensor" ? nextModuleFor(snapshot, focus, this.pinnedMetric(entry), dir) : nextModule(snapshot, focus, dir);
		}
		return result && !result.blocked ? result.focus : undefined;
	}

	/** Run one gesture. `ticks` is how many steps a rotation asks for (1 for a push). */
	private perform(entry: DialEntry, gesture: DialGesture, ticks: number): void {
		if (gesture === "none") return;
		if (gesture === "reload") {
			void requestRefresh(this.env.getSource(), this.env.logger);
			return;
		}
		const snapshot = this.env.getSource()?.getSnapshot();
		let focus = this.currentFocus(entry);
		if (!snapshot || !focus) return;
		const dir: Direction = ticks > 0 ? 1 : -1;
		let moved = false;
		for (let i = 0; i < Math.min(Math.abs(Math.trunc(ticks)), MAX_TICKS_PER_EVENT); i++) {
			const next = this.stepFrom(entry, snapshot, focus, gesture, dir);
			if (!next) break;
			focus = next;
			moved = true;
		}
		if (moved) this.apply(entry, focus);
	}

	/** Positive ticks go forward, negative backward; wraps around. What a tick does depends on the mode and on whether the dial is pushed. */
	rotate(actionId: string, ticks: number, pressed = false): void {
		const entry = this.entries.get(actionId);
		if (!entry || !Number.isFinite(ticks) || ticks === 0) return;
		if (pressed) entry.rotatedWhilePressed = true;
		const gestures = gesturesOf(entry.mode, entry.settings);
		this.perform(entry, pressed ? gestures.pressRotate : gestures.rotate, ticks);
	}

	private schedulePersist(entry: DialEntry): void {
		if (entry.persistTimer) clearTimeout(entry.persistTimer);
		entry.persistTimer = setTimeout(() => {
			entry.persistTimer = undefined;
			if (this.entries.get(entry.surface.id) !== entry) return;
			entry.lastWrittenMetric = entry.mode === "sensor" ? undefined : entry.metric;
			fireAndLog(entry.surface.setSettings(entry.settings), this.env.logger, "setSettings");
		}, this.persistMs);
		entry.persistTimer.unref?.();
	}

	/** The dial went down. Whether this was a push or the start of "rotate while pushed" is known on release. */
	down(actionId: string): void {
		const entry = this.entries.get(actionId);
		if (!entry) return;
		entry.pressed = true;
		entry.rotatedWhilePressed = false;
	}

	/** The dial came up: a push without rotation runs the push gesture (reload, or what the Custom Dial says). */
	up(actionId: string): void {
		const entry = this.entries.get(actionId);
		if (!entry) return;
		const rotated = entry.rotatedWhilePressed;
		entry.pressed = false;
		entry.rotatedWhilePressed = false;
		if (rotated) return;
		this.perform(entry, gesturesOf(entry.mode, entry.settings).push, 1);
	}

	/** A complete push without rotation. */
	press(actionId: string): void {
		this.down(actionId);
		this.up(actionId);
	}

	/** Tap on the strip: reload. */
	tap(actionId: string): void {
		if (!this.entries.has(actionId)) return;
		void requestRefresh(this.env.getSource(), this.env.logger);
	}

	/** Long touch: value -> min/max (where there are any) -> history (where the value has one) -> value. */
	hold(actionId: string): void {
		const entry = this.entries.get(actionId);
		if (!entry) return;
		const { metric } = this.effective(entry);
		const views: StripView[] = ["value"];
		if (METRICS[metric].min !== undefined) views.push("minmax");
		if (HISTORY_METRIC[metric]) views.push("history");
		const at = views.indexOf(this.wantedView(entry, metric));
		entry.view = views[(at + 1) % views.length]!;
		this.repaint(entry);
	}
}

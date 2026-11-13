/**
 * Behaviour of the weather dial (Stream Deck + encoder), SDK-free.
 *
 *  - rotate:         next / previous value of the focused sensor (what that sensor reports)
 *  - push:           next sensor that reports the shown value
 *  - rotate pushed:  next / previous station
 *  - touch tap:      reload: ask the service for the newest cloud data (a running poll is
 *                    joined, else at most one real request per minute; it cannot make the
 *                    station measure)
 *  - touch hold:     cycle the strip: value -> today's min/max (where there are any) ->
 *                    mini history (where the value has one) -> value
 *
 * By default the dial FOLLOWS the plugin-wide focus (setting `followFocus`, default true):
 * navigation moves the focus and every follower repaints. A pinned dial (`followFocus` off)
 * keeps its own module and value in its own settings, written after a short quiet period so
 * fast rotation does not hammer the settings store, and never touches the focus.
 * A dial without a focus store behaves as pinned.
 */

import type { ConnectionState, HistoryWindow } from "../adapter/station/types.ts";
import {
	displayMetricOf,
	focusModuleKey,
	metricKeyOf,
	nextMetric,
	nextModule,
	nextStation,
	resolveFocus,
	type Direction,
	type Focus,
	type NavResult,
} from "../focus/navigate.ts";
import { followFocusOf, historyWindowOf, type ActionSettings } from "../focus/settings.ts";
import { BUILT_IN_LAYOUT, buildDialFeedback, buildHistoryStrip, HISTORY_LAYOUT, type DialFeedbackPayload, type HistoryStripPayload } from "../render/dial-feedback.ts";
import { historyRequestFor } from "../render/history-view.ts";
import { HISTORY_METRIC, isDisplayMetricId, metricsReportedBy, METRICS, type DisplayMetricId } from "../render/metrics.ts";
import { adoptionCandidate, findModule, makeModuleKey } from "../render/select.ts";
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

interface DialEntry extends BaseEntry<DialSurface> {
	/** Pinned face; undefined = first measurement the module reports. Unused while following. */
	metric: DisplayMetricId | undefined;
	view: StripView;
	painted: string | undefined;
	/** The layout we last asked the strip to use; undefined until the first paint. */
	layout: string | undefined;
	persistTimer: ReturnType<typeof setTimeout> | undefined;
	/** The face we last wrote ourselves; lets us recognise our own settings echo. */
	lastWrittenMetric: string | undefined;
	slot: HistorySlot;
	pressed: boolean;
	rotatedWhilePressed: boolean;
}

export interface DialControllerEnv extends ControllerEnv {
	persistMs?: number;
}

const LOADING: ConnectionState = { kind: "loading" };
const FALLBACK_METRIC: DisplayMetricId = "temperature";

export class DialController extends ControllerBase<DialSurface, DialEntry> {
	private readonly persistMs: number;

	constructor(env: DialControllerEnv) {
		super(env);
		this.persistMs = env.persistMs ?? PERSIST_METRIC_MS;
	}

	protected createEntry(surface: DialSurface, settings: ActionSettings): DialEntry {
		const entry: DialEntry = {
			surface,
			settings,
			unsubscribe: undefined,
			metric: isDisplayMetricId(settings.metric) ? settings.metric : undefined,
			view: "value",
			painted: undefined,
			layout: undefined,
			persistTimer: undefined,
			lastWrittenMetric: undefined,
			slot: undefined as never,
			pressed: false,
			rotatedWhilePressed: false,
		};
		entry.slot = new HistorySlot({
			fetch: (request) => this.env.getHistory?.(request),
			now: () => this.env.now(),
			logger: this.env.logger,
			onResult: () => {
				if (this.entries.get(surface.id) === entry) this.repaint(entry);
			},
		});
		return entry;
	}

	private follows(entry: DialEntry): boolean {
		return followFocusOf(entry.settings, true) && this.env.focus !== undefined;
	}

	protected override followsFocus(entry: DialEntry): boolean {
		return this.follows(entry);
	}

	/** Module the pinned dial reads: its own choice, else what adoption would pick. */
	private reportedMetrics(entry: DialEntry): DisplayMetricId[] {
		return this.reportedMetricsFor(entry.settings.moduleKey);
	}

	private reportedMetricsFor(moduleKey: string | undefined): DisplayMetricId[] {
		const snapshot = this.env.getSource()?.getSnapshot();
		if (!snapshot) return [];
		const selected = moduleKey === undefined ? adoptionCandidate(snapshot, FALLBACK_METRIC) : findModule(snapshot, moduleKey);
		return selected ? metricsReportedBy(selected.module.values) : [];
	}

	private pinnedMetric(entry: DialEntry): DisplayMetricId {
		return entry.metric ?? this.reportedMetrics(entry)[0] ?? FALLBACK_METRIC;
	}

	/** What the dial shows now: the focus while following, its own choice otherwise. */
	private effective(entry: DialEntry): { metric: DisplayMetricId; settings: ActionSettings } {
		const own = { metric: this.pinnedMetric(entry), settings: entry.settings };
		if (!this.follows(entry)) return own;
		const focus = resolveFocus(this.env.getSource()?.getSnapshot(), this.env.focus?.get());
		const metric = focus ? displayMetricOf(focus.metric) : undefined;
		if (!focus || !metric) return own;
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

	protected adoptionMetric(): DisplayMetricId {
		return FALLBACK_METRIC;
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
		const metric = displayMetricOf(focus.metric);
		entry.metric = metric;
		entry.settings = { ...entry.settings, moduleKey: makeModuleKey(focus.stationId, focus.moduleId), metric };
		this.schedulePersist(entry);
		this.repaint(entry);
	}

	/** Positive ticks go forward, negative backward; wraps around. While pushed, ticks move between stations. */
	rotate(actionId: string, ticks: number, pressed = false): void {
		const entry = this.entries.get(actionId);
		if (!entry || !Number.isFinite(ticks) || ticks === 0) return;
		if (pressed) entry.rotatedWhilePressed = true;
		const snapshot = this.env.getSource()?.getSnapshot();
		let focus = this.currentFocus(entry);
		if (!snapshot || !focus) return;
		const step: (s: typeof snapshot, f: Focus, d: Direction) => NavResult | undefined = pressed ? nextStation : nextMetric;
		const dir: Direction = ticks > 0 ? 1 : -1;
		let moved = false;
		for (let i = 0; i < Math.min(Math.abs(Math.trunc(ticks)), MAX_TICKS_PER_EVENT); i++) {
			const result = step(snapshot, focus, dir);
			if (!result || result.blocked) break;
			focus = result.focus;
			moved = true;
		}
		if (moved) this.apply(entry, focus);
	}

	private schedulePersist(entry: DialEntry): void {
		if (entry.persistTimer) clearTimeout(entry.persistTimer);
		entry.persistTimer = setTimeout(() => {
			entry.persistTimer = undefined;
			if (this.entries.get(entry.surface.id) !== entry) return;
			entry.lastWrittenMetric = entry.metric;
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

	/** The dial came up: a push without rotation means "next sensor". */
	up(actionId: string): void {
		const entry = this.entries.get(actionId);
		if (!entry) return;
		const rotated = entry.rotatedWhilePressed;
		entry.pressed = false;
		entry.rotatedWhilePressed = false;
		if (rotated) return;
		const snapshot = this.env.getSource()?.getSnapshot();
		const focus = this.currentFocus(entry);
		const result = snapshot && focus ? nextModule(snapshot, focus, 1) : undefined;
		if (result && !result.blocked) this.apply(entry, result.focus);
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

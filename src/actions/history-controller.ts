/**
 * The history key: a sparkline of the focused (or, with followFocus off, the chosen)
 * module and metric over 6 hours, 24 hours or 3 days. SDK-free.
 *
 *  - press cycles the window and keeps it in the key's own settings;
 *  - history is requested only while the key is visible (see HistorySlot), at most as often
 *    as the service's cache expires, and never from a repaint of an unchanged request;
 *  - everything that is not a curve (loading, no data, errors, status) is a face, see
 *    render/history-view.ts.
 */

import type { HistoryWindow } from "../adapter/station/types.ts";
import { displayMetricOf, focusModuleKey, resolveFocus } from "../focus/navigate.ts";
import { followFocusOf, historyWindowOf, nextHistoryWindow, type ActionSettings } from "../focus/settings.ts";
import { buildHistoryView, historyRequestFor } from "../render/history-view.ts";
import { isDisplayMetricId, type DisplayMetricId } from "../render/metrics.ts";
import { findModule } from "../render/select.ts";
import type { ConnectionState } from "../adapter/station/types.ts";
import { ControllerBase, type BaseEntry, type ControllerEnv } from "./controller-base.ts";
import { fireAndLog } from "./fire-and-log.ts";
import { HistorySlot, isHistoryAskable } from "./history-slot.ts";
import { writeKeyFace, type FaceEntry, type KeySurface } from "./key-controller.ts";

interface HistoryEntry extends BaseEntry<KeySurface>, FaceEntry {
	readonly defaultMetric: DisplayMetricId;
	window: HistoryWindow;
	/** Windows we wrote and whose settings echo has not come back yet. */
	pendingWrites: HistoryWindow[];
	slot: HistorySlot;
}

const LOADING: ConnectionState = { kind: "loading" };

export class HistoryController extends ControllerBase<KeySurface, HistoryEntry> {
	protected createEntry(surface: KeySurface, settings: ActionSettings, extra: unknown): HistoryEntry {
		const entry: HistoryEntry = {
			surface,
			settings,
			unsubscribe: undefined,
			defaultMetric: isDisplayMetricId(extra) ? extra : "temperature",
			paintedImage: undefined,
			paintedTitle: undefined,
			titlePainted: false,
			window: historyWindowOf(settings),
			pendingWrites: [],
			slot: undefined as never,
		};
		entry.slot = this.newSlot(entry);
		return entry;
	}

	private newSlot(entry: HistoryEntry): HistorySlot {
		return new HistorySlot({
			fetch: (request) => this.env.getHistory?.(request),
			now: () => this.env.now(),
			logger: this.env.logger,
			onResult: () => {
				if (this.entries.get(entry.surface.id) === entry) this.repaint(entry);
			},
		});
	}

	protected override followsFocus(entry: HistoryEntry): boolean {
		return followFocusOf(entry.settings, true) && this.env.focus !== undefined;
	}

	protected override presetMetric(entry: HistoryEntry): DisplayMetricId {
		return entry.defaultMetric;
	}

	protected adoptionMetric(entry: HistoryEntry): DisplayMetricId {
		return isDisplayMetricId(entry.settings.metric) ? entry.settings.metric : entry.defaultMetric;
	}

	protected forgetPainted(entry: HistoryEntry): void {
		entry.paintedImage = undefined;
		entry.paintedTitle = undefined;
		entry.titlePainted = false;
	}

	protected release(entry: HistoryEntry): void {
		entry.slot.dispose();
	}

	/** A settings echo of our own window write must not undo a newer press. */
	protected override reconcileSettings(entry: HistoryEntry, incoming: ActionSettings): ActionSettings {
		const incomingWindow = historyWindowOf(incoming);
		const at = entry.pendingWrites.indexOf(incomingWindow);
		if (at !== -1) {
			entry.pendingWrites.splice(0, at + 1);
			return { ...incoming, historyWindow: entry.window };
		}
		entry.window = incomingWindow;
		return incoming;
	}

	private target(entry: HistoryEntry): { metric: DisplayMetricId; moduleKey: string | undefined } {
		const own = {
			metric: isDisplayMetricId(entry.settings.metric) ? entry.settings.metric : entry.defaultMetric,
			moduleKey: entry.settings.moduleKey,
		};
		if (!this.followsFocus(entry)) return own;
		const focus = resolveFocus(this.env.getSource()?.getSnapshot(), this.env.focus?.get());
		const metric = focus ? displayMetricOf(focus.metric) : undefined;
		return focus && metric ? { metric, moduleKey: focusModuleKey(focus) } : own;
	}

	protected paint(entry: HistoryEntry): void {
		const source = this.env.getSource();
		const snapshot = source?.getSnapshot();
		const { metric, moduleKey } = this.target(entry);
		const selected = snapshot && moduleKey !== undefined ? findModule(snapshot, moduleKey) : undefined;
		// Ask for history only while there is something to show it for: a connected source,
		// a snapshot with the module in it. The service never sees invisible or status-only keys.
		const connection = source?.getConnectionState() ?? LOADING;
		const askable = isHistoryAskable({ hasSource: source !== undefined, connection, moduleFound: selected !== undefined });
		const request = askable && selected ? historyRequestFor(selected, metric, entry.window) : undefined;
		const result = entry.slot.view(request);
		const view = buildHistoryView({
			metric,
			settings: { ...entry.settings, moduleKey },
			global: this.env.getGlobal(),
			hasSource: source !== undefined,
			connection,
			snapshot,
			now: this.env.now(),
			window: entry.window,
			result,
		});
		writeKeyFace(entry, view, this.env.logger);
	}

	/** Cycle 6 h -> 24 h -> 3 days and remember it in the key's settings. */
	press(actionId: string): void {
		const entry = this.entries.get(actionId);
		if (!entry) return;
		entry.window = nextHistoryWindow(entry.window);
		entry.pendingWrites.push(entry.window);
		if (entry.pendingWrites.length > 8) entry.pendingWrites.shift();
		entry.settings = { ...entry.settings, historyWindow: entry.window };
		fireAndLog(entry.surface.setSettings(entry.settings), this.env.logger, "setSettings");
		this.repaint(entry);
	}
}

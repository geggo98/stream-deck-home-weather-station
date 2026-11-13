/**
 * The navigation and utility keys of the focus family, SDK-free: reload, next/previous
 * value, sensor and station, auto rotate, data age and battery.
 *
 * Every one of them acts on the plugin-wide focus (`FocusStore`) and paints from the
 * snapshot cache. A navigation that has nowhere to go (one sensor, one station) is a
 * dimmed face and flashes the key's alert on a press, nothing else. A reload asks the
 * service for the newest cloud data: a running poll is joined, otherwise at most one real request per minute is made; it cannot make the station measure.
 *
 * Auto rotate registers its key with ONE shared `AutoRotator`, only while the key is visible.
 */

import type { ConnectionState } from "../adapter/station/types.ts";
import { AutoRotator } from "../focus/auto-rotate.ts";
import { locate, nextMetric, resolveFocus, type Focus } from "../focus/navigate.ts";
import { autoRotateSecondsOf, type ActionSettings } from "../focus/settings.ts";
import { buildNavView, infoPages, isNavKind, navigationPreview, type NavKind } from "../render/nav-view.ts";
import type { DisplayMetricId } from "../render/metrics.ts";
import { classifyConnection } from "../render/status.ts";
import { ControllerBase, type BaseEntry, type ControllerEnv } from "./controller-base.ts";
import { fireAndLog } from "./fire-and-log.ts";
import { requestRefresh, writeKeyFace, type FaceEntry, type KeySurface } from "./key-controller.ts";

interface NavEntry extends BaseEntry<KeySurface>, FaceEntry {
	readonly kind: NavKind;
	refreshing: boolean;
	infoPage: number;
}

export interface NavControllerEnv extends ControllerEnv {
	/** Injectable for tests; the default is a private rotator that advances the focus. */
	rotator?: AutoRotator;
}

const LOADING: ConnectionState = { kind: "loading" };

export class NavController extends ControllerBase<KeySurface, NavEntry, NavKind> {
	readonly rotator: AutoRotator;
	private readonly offRotator: () => void;

	constructor(env: NavControllerEnv) {
		super(env);
		this.rotator = env.rotator ?? new AutoRotator(() => this.advance());
		this.offRotator = this.rotator.subscribe(() => {
			// The rotation stopped: persist where it ended (the steps themselves are not written).
			if (!this.rotator.isOn) this.env.focus?.flush();
			this.repaintAll();
		});
	}

	/** `extra` is the NavKind of the action; the check is a guard against a caller that bypasses the types. */
	protected createEntry(surface: KeySurface, settings: ActionSettings, extra: NavKind | undefined): NavEntry {
		if (!isNavKind(extra)) throw new Error(`unknown navigation key kind: ${String(extra).slice(0, 32)}`);
		return {
			surface,
			settings,
			unsubscribe: undefined,
			kind: extra,
			refreshing: false,
			infoPage: 0,
			paintedImage: undefined,
			paintedTitle: undefined,
			titlePainted: false,
		};
	}

	protected override followsFocus(): boolean {
		return true;
	}

	protected adoptionMetric(): DisplayMetricId {
		return "temperature";
	}

	protected forgetPainted(entry: NavEntry): void {
		entry.paintedImage = undefined;
		entry.paintedTitle = undefined;
		entry.titlePainted = false;
	}

	protected release(entry: NavEntry): void {
		if (entry.kind !== "auto-rotate") return;
		this.rotator.unregister(entry.surface.id);
		if (!this.rotator.running) this.env.focus?.flush();
	}

	protected override afterBind(entry: NavEntry): void {
		if (entry.kind === "auto-rotate") {
			this.rotator.register(entry.surface.id, autoRotateSecondsOf(entry.settings), entry.settings.autoRotateStartOn === true);
		}
	}

	override dispose(): void {
		super.dispose();
		this.offRotator();
		this.rotator.dispose();
		this.env.focus?.flush();
	}

	private focusOf(): Focus | undefined {
		return resolveFocus(this.env.getSource()?.getSnapshot(), this.env.focus?.get());
	}

	protected paint(entry: NavEntry): void {
		const source = this.env.getSource();
		const view = buildNavView({
			kind: entry.kind,
			hasSource: source !== undefined,
			connection: source?.getConnectionState() ?? LOADING,
			snapshot: source?.getSnapshot(),
			focus: this.focusOf(),
			now: this.env.now(),
			refreshing: entry.refreshing,
			autoRotateOn: this.rotator.isOn,
			autoRotateSeconds: autoRotateSecondsOf(entry.settings),
			infoPage: entry.infoPage,
		});
		writeKeyFace(entry, view, this.env.logger);
	}

	/** One tick of the shared timer: the next value of the focused sensor, wrapping around. */
	private advance(): void {
		const snapshot = this.env.getSource()?.getSnapshot();
		const store = this.env.focus;
		if (!snapshot || !store) return;
		const result = nextMetric(snapshot, store.get(), 1);
		// Not persisted per step: see FocusStore. The last value is flushed when the rotation stops.
		if (result && !result.blocked) store.set(result.focus, { persist: false });
	}

	private alert(entry: NavEntry): void {
		const show = entry.surface.showAlert?.();
		if (show) fireAndLog(show, this.env.logger, "showAlert");
	}

	press(actionId: string): void {
		const entry = this.entries.get(actionId);
		if (!entry) return;
		switch (entry.kind) {
			case "refresh":
				this.reload(entry);
				return;
			case "auto-rotate":
				this.rotator.toggle();
				return;
			case "info": {
				const snapshot = this.env.getSource()?.getSnapshot();
				const focus = this.focusOf();
				const at = snapshot && focus ? locate(snapshot, focus) : undefined;
				if (infoPages(at?.module).length < 2) {
					this.alert(entry);
					return;
				}
				entry.infoPage++;
				this.repaint(entry);
				return;
			}
			default:
				this.navigate(entry);
		}
	}

	private reload(entry: NavEntry): void {
		if (entry.refreshing) return;
		entry.refreshing = true;
		this.repaint(entry);
		void requestRefresh(this.env.getSource(), this.env.logger).then(() => {
			entry.refreshing = false;
			if (this.entries.get(entry.surface.id) === entry) this.repaint(entry);
		});
	}

	private navigate(entry: NavEntry): void {
		const source = this.env.getSource();
		const snapshot = source?.getSnapshot();
		// A face that shows a status (signed out, offline, ...) is not a navigation key right now.
		const status = classifyConnection(source !== undefined, source?.getConnectionState() ?? LOADING, snapshot);
		const result = status ? undefined : navigationPreview(entry.kind, snapshot, this.focusOf());
		if (!result || result.blocked || !this.env.focus) {
			this.alert(entry);
			return;
		}
		this.env.focus.set(result.focus);
	}
}

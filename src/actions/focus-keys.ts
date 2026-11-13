/**
 * The focus family's key actions: the focus display, the history key and the navigation
 * and utility keys. Thin classes: behaviour lives in key-controller.ts (display),
 * history-controller.ts and nav-controller.ts, all SDK-free.
 *
 * Every class carries its own `@action` decorator with a literal catalog id, so
 * tests/catalog-manifest.test.ts can tell a missing or an extra registration.
 */

import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import type { NavKind } from "../render/nav-view.ts";
import { uuidFor } from "./catalog.ts";
import { surfaceOf, type KeySettings } from "./measurement-keys.ts";
import { historyController, keyController, navController, routePiMessage } from "./runtime.ts";

/** The focus display: a measurement key that always follows the focus. */
@action({ UUID: uuidFor("focus") })
export class FocusDisplayKeyAction extends SingletonAction<KeySettings> {
	override async onWillAppear(ev: WillAppearEvent<KeySettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		await keyController().appear(surfaceOf(ev.action), ev.payload.settings, { metric: "temperature", follow: true });
	}
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
		keyController().settingsChanged(ev.action.id, ev.payload.settings);
	}
	override onKeyDown(ev: KeyDownEvent<KeySettings>): void {
		keyController().press(ev.action.id);
	}
	override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
		keyController().disappear(ev.action.id);
	}
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, KeySettings>): Promise<void> {
		await routePiMessage(ev.action.id, ev.payload);
	}
}

@action({ UUID: uuidFor("history") })
export class HistoryKeyAction extends SingletonAction<KeySettings> {
	override async onWillAppear(ev: WillAppearEvent<KeySettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		await historyController().appear(surfaceOf(ev.action), ev.payload.settings, "temperature");
	}
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
		historyController().settingsChanged(ev.action.id, ev.payload.settings);
	}
	override onKeyDown(ev: KeyDownEvent<KeySettings>): void {
		historyController().press(ev.action.id);
	}
	override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
		historyController().disappear(ev.action.id);
	}
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, KeySettings>): Promise<void> {
		await routePiMessage(ev.action.id, ev.payload);
	}
}

abstract class NavKeyAction extends SingletonAction<KeySettings> {
	private readonly kind: NavKind;

	protected constructor(kind: NavKind) {
		super();
		this.kind = kind;
	}
	override async onWillAppear(ev: WillAppearEvent<KeySettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		await navController().appear(surfaceOf(ev.action), ev.payload.settings, this.kind);
	}
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
		navController().settingsChanged(ev.action.id, ev.payload.settings);
	}
	override onKeyDown(ev: KeyDownEvent<KeySettings>): void {
		navController().press(ev.action.id);
	}
	override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
		navController().disappear(ev.action.id);
	}
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, KeySettings>): Promise<void> {
		await routePiMessage(ev.action.id, ev.payload);
	}
}

@action({ UUID: uuidFor("focus-refresh") })
export class FocusRefreshKeyAction extends NavKeyAction {
	constructor() {
		super("refresh");
	}
}

@action({ UUID: uuidFor("focus-next-metric") })
export class FocusNextMetricKeyAction extends NavKeyAction {
	constructor() {
		super("next-metric");
	}
}

@action({ UUID: uuidFor("focus-prev-metric") })
export class FocusPrevMetricKeyAction extends NavKeyAction {
	constructor() {
		super("prev-metric");
	}
}

@action({ UUID: uuidFor("focus-next-sensor") })
export class FocusNextSensorKeyAction extends NavKeyAction {
	constructor() {
		super("next-sensor");
	}
}

@action({ UUID: uuidFor("focus-prev-sensor") })
export class FocusPrevSensorKeyAction extends NavKeyAction {
	constructor() {
		super("prev-sensor");
	}
}

@action({ UUID: uuidFor("focus-next-station") })
export class FocusNextStationKeyAction extends NavKeyAction {
	constructor() {
		super("next-station");
	}
}

@action({ UUID: uuidFor("focus-prev-station") })
export class FocusPrevStationKeyAction extends NavKeyAction {
	constructor() {
		super("prev-station");
	}
}

@action({ UUID: uuidFor("auto-rotate") })
export class AutoRotateKeyAction extends NavKeyAction {
	constructor() {
		super("auto-rotate");
	}
}

@action({ UUID: uuidFor("info") })
export class InfoKeyAction extends NavKeyAction {
	constructor() {
		super("info");
	}
}

/** Every focus-family action, in catalog order; plugin.ts registers them. */
export function createFocusActions(): SingletonAction<KeySettings>[] {
	return [
		new FocusDisplayKeyAction(),
		new FocusRefreshKeyAction(),
		new FocusNextMetricKeyAction(),
		new FocusPrevMetricKeyAction(),
		new FocusNextSensorKeyAction(),
		new FocusPrevSensorKeyAction(),
		new FocusNextStationKeyAction(),
		new FocusPrevStationKeyAction(),
		new AutoRotateKeyAction(),
		new InfoKeyAction(),
		new HistoryKeyAction(),
	];
}

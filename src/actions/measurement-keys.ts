/**
 * The keypad actions: one class per metric, all sharing one implementation.
 *
 * `@action` is a TC39 standard decorator, so a bundler without a decorator transform
 * would break these at runtime with exit code 0 and no warning; tests/bundle-artifact.test.ts
 * guards that. The UUIDs come from the catalog, so they cannot drift from the manifest.
 */

import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import type { ActionSettings } from "../focus/settings.ts";
import type { DisplayMetricId } from "../render/metrics.ts";
import { keypadSpec, uuidFor, type KeypadId } from "./catalog.ts";
import type { KeySurface } from "./key-controller.ts";
import { keyController, routePiMessage } from "./runtime.ts";

/** Stream Deck settings are a JSON object; our interface has no index signature, hence the intersection. */
export type KeySettings = ActionSettings & JsonObject;

export function surfaceOf(key: KeyAction<KeySettings>): KeySurface {
	return {
		id: key.id,
		showAlert: () => key.showAlert(),
		setImage: (image) => key.setImage(image),
		setTitle: (title) => key.setTitle(title),
		setSettings: (settings) => key.setSettings(settings as KeySettings),
	};
}

export abstract class MeasurementKeyAction extends SingletonAction<KeySettings> {
	private readonly metric: DisplayMetricId;

	protected constructor(id: KeypadId) {
		super();
		this.metric = keypadSpec(id).metric;
	}

	override async onWillAppear(ev: WillAppearEvent<KeySettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		await keyController().appear(surfaceOf(ev.action), ev.payload.settings, this.metric);
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

@action({ UUID: uuidFor("temperature") })
export class TemperatureKeyAction extends MeasurementKeyAction {
	constructor() {
		super("temperature");
	}
}

@action({ UUID: uuidFor("humidity") })
export class HumidityKeyAction extends MeasurementKeyAction {
	constructor() {
		super("humidity");
	}
}

@action({ UUID: uuidFor("co2") })
export class Co2KeyAction extends MeasurementKeyAction {
	constructor() {
		super("co2");
	}
}

@action({ UUID: uuidFor("noise") })
export class NoiseKeyAction extends MeasurementKeyAction {
	constructor() {
		super("noise");
	}
}

@action({ UUID: uuidFor("pressure") })
export class PressureKeyAction extends MeasurementKeyAction {
	constructor() {
		super("pressure");
	}
}

@action({ UUID: uuidFor("rain") })
export class RainKeyAction extends MeasurementKeyAction {
	constructor() {
		super("rain");
	}
}

@action({ UUID: uuidFor("wind") })
export class WindKeyAction extends MeasurementKeyAction {
	constructor() {
		super("wind");
	}
}

/** Every keypad action, in catalog order; plugin.ts registers them. */
export function createKeypadActions(): MeasurementKeyAction[] {
	return [
		new TemperatureKeyAction(),
		new HumidityKeyAction(),
		new Co2KeyAction(),
		new NoiseKeyAction(),
		new PressureKeyAction(),
		new RainKeyAction(),
		new WindKeyAction(),
	];
}

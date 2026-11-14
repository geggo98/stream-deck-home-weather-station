/**
 * The dial actions share one implementation (dial-controller.ts); this file holds the shared
 * event wiring and the Custom Dial (id weather-dial, the UUID of the original dial). The Sensor
 * Dial and the Value Dial are thin classes in weather-dial-sensor.ts and weather-dial-value.ts,
 * each with its own literal @action decorator.
 *
 * Custom Dial: turn, turn while pressed and press do what the settings say (default: next value,
 * next station, next sensor); tap = reload, long touch = min/max or history.
 * Content goes out via `setFeedback` into the built-in `$B1` layout (see render/dial-feedback.ts);
 * the history view switches the strip to the custom layout `layouts/history-strip.json` and back.
 *
 * UNVERIFIED on hardware: no Stream Deck + was available while writing this; the
 * behaviour follows the SDK types and the sibling project's measurements.
 */

import {
	action,
	SingletonAction,
	type DialAction,
	type DialDownEvent,
	type DialUpEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type SendToPluginEvent,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import type { DialFeedbackPayload, HistoryStripPayload } from "../render/dial-feedback.ts";
import { uuidFor } from "./catalog.ts";
import type { DialMode, DialSurface } from "./dial-controller.ts";
import type { KeySettings } from "./measurement-keys.ts";
import { dialController, routePiMessage } from "./runtime.ts";

export function dialSurfaceOf(dial: DialAction<KeySettings>): DialSurface {
	return {
		id: dial.id,
		setFeedback: (payload: DialFeedbackPayload | HistoryStripPayload) => dial.setFeedback(payload),
		setFeedbackLayout: (layout) => dial.setFeedbackLayout(layout),
		setSettings: (settings) => dial.setSettings(settings as KeySettings),
	};
}

/** Event wiring of all three dials; a subclass names its mode and carries its own @action decorator. */
export abstract class DialActionBase extends SingletonAction<KeySettings> {
	protected abstract readonly mode: DialMode;

	override async onWillAppear(ev: WillAppearEvent<KeySettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		await dialController().appear(dialSurfaceOf(ev.action), ev.payload.settings, this.mode);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
		dialController().settingsChanged(ev.action.id, ev.payload.settings);
	}

	override onDialRotate(ev: DialRotateEvent<KeySettings>): void {
		dialController().rotate(ev.action.id, ev.payload.ticks, ev.payload.pressed);
	}

	override onDialDown(ev: DialDownEvent<KeySettings>): void {
		dialController().down(ev.action.id);
	}

	override onDialUp(ev: DialUpEvent<KeySettings>): void {
		dialController().up(ev.action.id);
	}

	override onTouchTap(ev: TouchTapEvent<KeySettings>): void {
		if (ev.payload.hold) dialController().hold(ev.action.id);
		else dialController().tap(ev.action.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
		dialController().disappear(ev.action.id);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, KeySettings>): Promise<void> {
		await routePiMessage(ev.action.id, ev.payload);
	}
}

/** The Custom Dial: gestures from its settings. */
@action({ UUID: uuidFor("weather-dial") })
export class WeatherDialAction extends DialActionBase {
	protected readonly mode = "custom";
}

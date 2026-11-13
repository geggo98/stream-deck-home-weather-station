/**
 * The weather dial: rotate = next/previous value, push = next sensor, rotate while pushed =
 * next station, tap = reload, long touch = min/max or history (see dial-controller.ts). Content goes out via `setFeedback` into the built-in
 * `$B1` layout (see render/dial-feedback.ts).
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
import { DIAL_SPEC, uuidFor } from "./catalog.ts";
import type { DialSurface } from "./dial-controller.ts";
import type { KeySettings } from "./measurement-keys.ts";
import { dialController, routePiMessage } from "./runtime.ts";

function surfaceOf(dial: DialAction<KeySettings>): DialSurface {
	return {
		id: dial.id,
		setFeedback: (payload: DialFeedbackPayload | HistoryStripPayload) => dial.setFeedback(payload),
		setFeedbackLayout: (layout) => dial.setFeedbackLayout(layout),
		setSettings: (settings) => dial.setSettings(settings as KeySettings),
	};
}

@action({ UUID: uuidFor(DIAL_SPEC.id) })
export class WeatherDialAction extends SingletonAction<KeySettings> {
	override async onWillAppear(ev: WillAppearEvent<KeySettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		await dialController().appear(surfaceOf(ev.action), ev.payload.settings);
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

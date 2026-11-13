/**
 * The action catalog: the single source of truth for action ids, UUIDs, names, icons
 * and Property Inspector paths. The manifest's `Actions` array is generated from it
 * (scripts/generate-manifest.ts), the action classes take their UUIDs from it, and
 * tests/catalog-manifest.test.ts fails when any of the three drift apart.
 *
 * Pure data and pure functions: importing it pulls in no SDK.
 */

import type { GlyphName } from "../render/glyph-names.ts";
import type { DisplayMetricId } from "../render/metrics.ts";

/** Reverse-DNS plugin id; also the `.sdPlugin` folder name. Keep in step with scripts/lib/plugin-id.ts. */
export const PLUGIN_ID = "de.schwetschke.sd.home-weather-station";

export interface KeypadSpec {
	readonly id: "temperature" | "humidity" | "co2" | "noise" | "pressure" | "rain" | "wind";
	readonly name: string;
	readonly tooltip: string;
	readonly glyph: GlyphName;
	/** The metric this key shows unless the Property Inspector picks another one. */
	readonly metric: DisplayMetricId;
	readonly propertyInspector: "ui/measurement.html";
}

export interface DialSpec {
	readonly id: "weather-dial";
	readonly name: string;
	readonly tooltip: string;
	readonly glyph: GlyphName;
	readonly propertyInspector: "ui/dial.html";
	/** Built-in layout: icon, title, value, indicator bar. */
	readonly encoderLayout: "$B1";
	readonly trigger: { readonly Push: string; readonly Rotate: string; readonly Touch: string };
}

const PI_KEY = "ui/measurement.html" as const;

/**
 * What a press does, the meaning behind every tooltip and comment on it. A press asks the service
 * for a refresh; the service joins a poll that is already running and otherwise makes a real
 * request at most once a minute (none while it backs off or is signed out). So a press CAN
 * cause one request, but never more than one per minute, however often it is pressed.
 */
export const KEYPAD_SPECS = [
	{ id: "temperature", name: "Temperature", tooltip: "Shows a temperature. Press to request fresh data (at most once a minute) and to see today's minimum and maximum.", glyph: "thermometer", metric: "temperature", propertyInspector: PI_KEY },
	{ id: "humidity", name: "Humidity", tooltip: "Shows the relative humidity. Press to request fresh data (at most once a minute).", glyph: "droplets", metric: "humidity", propertyInspector: PI_KEY },
	{ id: "co2", name: "CO2", tooltip: "Shows the indoor CO2 concentration. Press to request fresh data (at most once a minute).", glyph: "leaf", metric: "co2", propertyInspector: PI_KEY },
	{ id: "noise", name: "Noise", tooltip: "Shows the indoor noise level. Press to request fresh data (at most once a minute).", glyph: "volume-2", metric: "noise", propertyInspector: PI_KEY },
	{ id: "pressure", name: "Pressure", tooltip: "Shows the air pressure. Press to request fresh data (at most once a minute).", glyph: "gauge", metric: "pressure", propertyInspector: PI_KEY },
	{ id: "rain", name: "Rain", tooltip: "Shows the rainfall of the last 24 hours. Press to request fresh data (at most once a minute).", glyph: "cloud-rain", metric: "rain24h", propertyInspector: PI_KEY },
	{ id: "wind", name: "Wind", tooltip: "Shows the wind speed and direction. Press to request fresh data (at most once a minute).", glyph: "wind", metric: "wind", propertyInspector: PI_KEY },
] as const satisfies readonly KeypadSpec[];

export const DIAL_SPEC = {
	id: "weather-dial",
	name: "Weather Dial",
	tooltip: "Turn for the next value, press for the next sensor, turn while pressed for the next station. Tap the strip to request fresh data (at most once a minute), hold it for minimum and maximum or the 24 hour history.",
	glyph: "circle-gauge",
	propertyInspector: "ui/dial.html",
	encoderLayout: "$B1",
	trigger: { Push: "Next sensor", Rotate: "Next value (pressed: next station)", Touch: "Tap: reload (once a minute at most), hold: min/max or history" },
} as const satisfies DialSpec;

/**
 * What a focus-family key does. `display` and `history` are measurement-like (they have
 * settings); the rest are navigation or utility keys. They have a page too, so the account
 * section is reachable from any key; the navigation keys' page has no settings of its own.
 */
export type FocusKind =
	| "display"
	| "sensor-focus"
	| "refresh"
	| "next-metric"
	| "prev-metric"
	| "next-sensor"
	| "prev-sensor"
	| "next-station"
	| "prev-station"
	| "auto-rotate"
	| "info"
	| "history";

export interface FocusSpec {
	readonly id: string;
	readonly kind: FocusKind;
	readonly name: string;
	readonly tooltip: string;
	readonly glyph: GlyphName;
	/** Property Inspector page. Every action has one, so a first-time user who drops ANY key finds the account section. */
	readonly propertyInspector?: "ui/focus.html" | "ui/sensor-focus.html" | "ui/auto-rotate.html" | "ui/info.html" | "ui/history.html" | "ui/navigation.html";
}

/** The page of the seven navigation keys: what the key does, plus the shared account section (no settings of their own). */
const NAV_PI = "ui/navigation.html" as const;

/**
 * The focus family. Tooltips say exactly what
 * happens: a reload can only fetch the newest data the cloud has (stations upload about
 * every 10 minutes), never make the station measure, and makes at most one real request
 * per minute.
 */
export const FOCUS_SPECS = [
	{ id: "focus", kind: "display", name: "Focus Display", tooltip: "Shows the focused sensor AND the focused value. Follows the focus set by the navigation keys and the dial. Press to request fresh data (at most once a minute). No alerts: a threshold fits one value, and this key changes value with the focus.", glyph: "crosshair", propertyInspector: "ui/focus.html" },
	{ id: "focus-sensor", kind: "sensor-focus", name: "Sensor Focus", tooltip: "Shows the value you choose for the sensor the focus points at; follows the Next/Previous Sensor and Station keys but not the Next/Previous Value keys", glyph: "locate-fixed", propertyInspector: "ui/sensor-focus.html" },
	{ id: "focus-refresh", kind: "refresh", name: "Reload", tooltip: "Fetches the newest data the cloud has (at most one real request per minute). It cannot make the station measure: stations upload about every 10 minutes. Shows how old the data is.", glyph: "refresh-cw", propertyInspector: NAV_PI },
	{ id: "focus-next-metric", kind: "next-metric", name: "Next Value", tooltip: "Moves the focus to the next value of the same sensor (for example temperature, then humidity). Shows which value comes next.", glyph: "step-forward", propertyInspector: NAV_PI },
	{ id: "focus-prev-metric", kind: "prev-metric", name: "Previous Value", tooltip: "Moves the focus to the previous value of the same sensor. Shows which value comes before.", glyph: "step-back", propertyInspector: NAV_PI },
	{ id: "focus-next-sensor", kind: "next-sensor", name: "Next Sensor", tooltip: "Keeps the value and moves the focus to the next sensor of the station that reports it (for example indoor, then outdoor temperature). Dimmed when there is no other sensor.", glyph: "circle-arrow-right", propertyInspector: NAV_PI },
	{ id: "focus-prev-sensor", kind: "prev-sensor", name: "Previous Sensor", tooltip: "Keeps the value and moves the focus to the previous sensor of the station that reports it. Dimmed when there is no other sensor.", glyph: "circle-arrow-left", propertyInspector: NAV_PI },
	{ id: "focus-next-station", kind: "next-station", name: "Next Station", tooltip: "Moves the focus to the next weather station of the account. Dimmed when the account has only one station.", glyph: "chevrons-right", propertyInspector: NAV_PI },
	{ id: "focus-prev-station", kind: "prev-station", name: "Previous Station", tooltip: "Moves the focus to the previous weather station of the account. Dimmed when the account has only one station.", glyph: "chevrons-left", propertyInspector: NAV_PI },
	{ id: "auto-rotate", kind: "auto-rotate", name: "Auto Rotate", tooltip: "Press to switch on or off: the focus then advances through the values of the focused sensor every few seconds. Off after a restart unless set to start on.", glyph: "repeat", propertyInspector: "ui/auto-rotate.html" },
	{ id: "info", kind: "info", name: "Data Age and Battery", tooltip: "Shows how old the data of the focused sensor is. Press to switch to its battery level (where the sensor reports one).", glyph: "info", propertyInspector: "ui/info.html" },
	{ id: "history", kind: "history", name: "History", tooltip: "Draws the recent course of the focused value (rain as bars). Press to switch between 6 hours, 24 hours and 3 days. Fetches history from the cloud only while visible.", glyph: "chart-line", propertyInspector: "ui/history.html" },
] as const satisfies readonly FocusSpec[];

export type KeypadId = (typeof KEYPAD_SPECS)[number]["id"];
export type FocusId = (typeof FOCUS_SPECS)[number]["id"];
export type ActionId = KeypadId | FocusId | typeof DIAL_SPEC.id;

export const ACTION_IDS: readonly ActionId[] = [...KEYPAD_SPECS.map((s) => s.id), ...FOCUS_SPECS.map((s) => s.id), DIAL_SPEC.id];

/** Action UUID: plugin id + "." + catalog id. Only known ids compile, so typos cannot drift. */
export function uuidFor(id: ActionId): string {
	return `${PLUGIN_ID}.${id}`;
}

export function keypadSpec(id: KeypadId): KeypadSpec {
	return KEYPAD_SPECS.find((s) => s.id === id)!;
}

export function focusSpec(id: FocusId): FocusSpec {
	return FOCUS_SPECS.find((s) => s.id === id)!;
}

/** Path (without extension, as the manifest wants it) of an action's picture files. */
export function iconPath(id: ActionId): string {
	return `imgs/actions/${id}/icon`;
}

export function keyImagePath(id: ActionId): string {
	return `imgs/actions/${id}/key`;
}

/** Every glyph the catalog itself needs, for the icon generator. */
export function catalogGlyphs(): GlyphName[] {
	return [...KEYPAD_SPECS.map((s) => s.glyph), ...FOCUS_SPECS.map((s) => s.glyph), DIAL_SPEC.glyph];
}

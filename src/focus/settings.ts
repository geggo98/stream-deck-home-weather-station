/**
 * Settings the focus family adds to a key or dial, read defensively.
 *
 * Stream Deck settings are whatever JSON the Property Inspector wrote: numbers arrive as
 * strings from text fields, fields may be missing or junk. Every accessor therefore takes
 * the raw object and validates; none throws. SDK-free.
 */

import type { HistoryWindow } from "../adapter/station/types.ts";
import type { DialGesture, MeasurementSettings } from "../pi-protocol.ts";

/** Fields the focus family adds to a key or dial. Raw: what the Property Inspector wrote (text fields give strings), read through the accessors below. */
export interface FocusSettings {
	/** true = behave like the focus display: module and metric come from the focus. */
	followFocus?: boolean;
	/** Alert thresholds in the display units of the key's unit system. */
	alertAbove?: number | string;
	alertBelow?: number | string;
	historyWindow?: HistoryWindow | string;
	autoRotateSeconds?: number | string;
	autoRotateStartOn?: boolean;
}

/**
 * What an action's settings really are: the measurement fields as stored, with the fields the
 * focus family widens (a threshold typed into a text field is a string; the window is any
 * string until `historyWindowOf` has checked it). `MeasurementSettings` declares the number
 * form of those fields; intersecting it with `FocusSettings` would narrow them to `number`
 * and make every `typeof` check on them look dead. Read them through `alertOf`,
 * `historyWindowOf` and `autoRotateSecondsOf`.
 */
export type ActionSettings = Omit<MeasurementSettings, keyof FocusSettings> & FocusSettings;

export const AUTO_ROTATE_DEFAULT_SECONDS = 8;
export const AUTO_ROTATE_MIN_SECONDS = 3;
export const AUTO_ROTATE_MAX_SECONDS = 60;

export const HISTORY_WINDOWS: readonly HistoryWindow[] = ["6h", "24h", "3d"];
export const DEFAULT_HISTORY_WINDOW: HistoryWindow = "24h";

function numberOf(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value.replace(",", ".").trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function followFocusOf(settings: FocusSettings | undefined, defaultValue: boolean): boolean {
	const v = settings?.followFocus;
	return typeof v === "boolean" ? v : defaultValue;
}

export interface AlertThresholds {
	readonly above: number | undefined;
	readonly below: number | undefined;
}

export function alertOf(settings: FocusSettings | undefined): AlertThresholds {
	return { above: numberOf(settings?.alertAbove), below: numberOf(settings?.alertBelow) };
}

export function historyWindowOf(settings: FocusSettings | undefined): HistoryWindow {
	const v = settings?.historyWindow;
	return HISTORY_WINDOWS.includes(v as HistoryWindow) ? (v as HistoryWindow) : DEFAULT_HISTORY_WINDOW;
}

export function nextHistoryWindow(window: HistoryWindow): HistoryWindow {
	return HISTORY_WINDOWS[(HISTORY_WINDOWS.indexOf(window) + 1) % HISTORY_WINDOWS.length]!;
}

export function autoRotateSecondsOf(settings: FocusSettings | undefined): number {
	const v = numberOf(settings?.autoRotateSeconds);
	if (v === undefined) return AUTO_ROTATE_DEFAULT_SECONDS;
	return Math.max(AUTO_ROTATE_MIN_SECONDS, Math.min(AUTO_ROTATE_MAX_SECONDS, Math.round(v)));
}

export const DIAL_GESTURES: readonly DialGesture[] = ["value", "sensor", "station", "reload", "none"];

/** One gesture setting of the Custom Dial, read defensively: anything that is not a known gesture gives the default. */
export function dialGestureOf(value: unknown, defaultValue: DialGesture): DialGesture {
	return DIAL_GESTURES.includes(value as DialGesture) ? (value as DialGesture) : defaultValue;
}

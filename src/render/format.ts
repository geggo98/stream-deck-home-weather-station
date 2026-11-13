/**
 * Unit choice and number formatting for display.
 *
 * The API always delivers metric values; conversion happens only here, at the last
 * moment, so cached data never changes meaning when a unit setting changes.
 * Intentionally independent of the adapter (the plugin layer codes against types.ts
 * only); the integrator may fold this into the adapter's units module later.
 */

import type { UnitPreferences } from "../adapter/station/types.ts";
import type { GlobalSettings, MeasurementSettings } from "../pi-protocol.ts";
import type { MetricDef } from "./metrics.ts";

export interface UnitContext {
	readonly temperature: "c" | "f";
	readonly pressure: UnitPreferences["pressureUnit"];
	readonly wind: UnitPreferences["windUnit"];
	readonly rain: "mm" | "in";
	/** Locale for the decimal separator; display hint only. */
	readonly locale?: string;
}

const METRIC_UNITS: UnitContext = { temperature: "c", pressure: "mbar", wind: "kmh", rain: "mm" };
const IMPERIAL_UNITS: UnitContext = { temperature: "f", pressure: "inhg", wind: "mph", rain: "in" };

/**
 * Pick units: the action's own choice, else the plugin-wide choice, else the Netatmo
 * account's preferences. "auto" (action) and "account" (global) both mean "follow the
 * next level down".
 */
export function resolveUnits(
	action: MeasurementSettings["unitSystem"],
	global: GlobalSettings["unitSystem"],
	prefs: UnitPreferences,
): UnitContext {
	const locale = prefs.locale;
	const explicit = action === "metric" || action === "imperial" ? action : global === "metric" || global === "imperial" ? global : undefined;
	if (explicit === "metric") return { ...METRIC_UNITS, locale };
	if (explicit === "imperial") return { ...IMPERIAL_UNITS, locale };
	return {
		temperature: prefs.unitSystem === "imperial" ? "f" : "c",
		pressure: prefs.pressureUnit,
		wind: prefs.windUnit,
		rain: prefs.unitSystem === "imperial" ? "in" : "mm",
		locale,
	};
}

const KMH_PER_MS = 3.6;
const MBAR_TO_INHG = 0.0295299830714;
const MBAR_TO_MMHG = 0.750061683;
const KMH_TO_MPH = 0.621371192;
const KMH_TO_KNOTS = 0.539956803;
const MM_PER_INCH = 25.4;

/** Upper km/h bounds of Beaufort forces 0..11 (the first km/h value of force n+1). */
const BEAUFORT_KMH = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118] as const;

export function beaufort(kmh: number): number {
	let force = 0;
	for (const bound of BEAUFORT_KMH) {
		if (kmh >= bound) force++;
	}
	return force;
}

export interface FormattedValue {
	/** Number as text, already rounded and localised. */
	readonly text: string;
	readonly unit: string;
	/** True when the unit hugs the number ("21.4°C", "45%") instead of being spaced ("1013 hPa"). */
	readonly tight: boolean;
	/** The rounded number in the display unit (what `text` shows). */
	readonly rounded: number;
}

interface Plan {
	readonly value: number;
	readonly decimals: number;
	readonly unit: string;
	readonly tight: boolean;
}

function plan(kind: MetricDef["kind"], value: number, units: UnitContext): Plan {
	switch (kind) {
		case "temperature":
			return units.temperature === "f"
				? { value: (value * 9) / 5 + 32, decimals: 1, unit: "°F", tight: true }
				: { value, decimals: 1, unit: "°C", tight: true };
		case "percent":
			return { value, decimals: 0, unit: "%", tight: true };
		case "ppm":
			return { value, decimals: 0, unit: "ppm", tight: false };
		case "decibel":
			return { value, decimals: 0, unit: "dB", tight: false };
		case "pressure":
			if (units.pressure === "inhg") return { value: value * MBAR_TO_INHG, decimals: 2, unit: "inHg", tight: false };
			if (units.pressure === "mmhg") return { value: value * MBAR_TO_MMHG, decimals: 0, unit: "mmHg", tight: false };
			return { value, decimals: 0, unit: "hPa", tight: false };
		case "rain":
			return units.rain === "in"
				? { value: value / MM_PER_INCH, decimals: 2, unit: "in", tight: false }
				: { value, decimals: 1, unit: "mm", tight: false };
		case "wind":
			switch (units.wind) {
				case "mph":
					return { value: value * KMH_TO_MPH, decimals: 0, unit: "mph", tight: false };
				case "ms":
					return { value: value / KMH_PER_MS, decimals: 1, unit: "m/s", tight: false };
				case "knots":
					return { value: value * KMH_TO_KNOTS, decimals: 0, unit: "kn", tight: false };
				case "beaufort":
					return { value: beaufort(value), decimals: 0, unit: "Bft", tight: false };
				default:
					return { value, decimals: 0, unit: "km/h", tight: false };
			}
	}
}

/**
 * Decimal text via Intl, with the locale as a hint. The locale string comes from the
 * API (untrusted): an invalid tag throws RangeError, which must never break a repaint.
 */
function formatNumber(value: number, decimals: number, locale: string | undefined): string {
	// Avoid "-0" and "-0.0": a reading that rounds to zero has no sign.
	const factor = 10 ** decimals;
	const rounded = Math.round(value * factor) / factor;
	const safe = Object.is(rounded, -0) ? 0 : rounded;
	try {
		return new Intl.NumberFormat(locale, {
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals,
			useGrouping: false,
		}).format(safe);
	} catch {
		return safe.toFixed(decimals);
	}
}

/** Convert a metric API value to the display unit and format it. */
export function formatMetric(metric: MetricDef, value: number, units: UnitContext): FormattedValue {
	const p = plan(metric.kind, value, units);
	const factor = 10 ** p.decimals;
	const rounded = Math.round(p.value * factor) / factor;
	return {
		text: formatNumber(p.value, p.decimals, units.locale),
		unit: p.unit,
		tight: p.tight,
		rounded: Object.is(rounded, -0) ? 0 : rounded,
	};
}

/** "21.4°C", "1013 hPa". */
export function joinValueUnit(f: FormattedValue): string {
	return f.tight ? `${f.text}${f.unit}` : `${f.text} ${f.unit}`;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** Eight-point compass abbreviation for a bearing in degrees; undefined for non-finite input. */
export function compassPoint(degrees: number): string | undefined {
	if (!Number.isFinite(degrees)) return undefined;
	const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
	return COMPASS[index];
}

/**
 * What can be shown: the display metrics, which API measurement each one reads, and
 * the ranges that drive the dial's indicator bar.
 *
 * A display metric is what the user picks (a key's metric, the dial's current face).
 * It maps to exactly one `MetricKey` of the adapter's data model, so "which value" is
 * never decided by a fallback chain that would make the label ambiguous.
 */

import type { HistoryMetric, MetricKey } from "../adapter/station/types.ts";
import type { GlyphName } from "./glyph-names.ts";

export type DisplayMetricId =
	| "temperature"
	| "humidity"
	| "co2"
	| "noise"
	| "pressure"
	| "absolutePressure"
	| "rain"
	| "rain1h"
	| "rain24h"
	| "wind"
	| "gust";

/** How a value is converted and rounded; see format.ts. */
export type UnitKind = "temperature" | "percent" | "ppm" | "decibel" | "pressure" | "rain" | "wind";

export interface MetricDef {
	readonly id: DisplayMetricId;
	/** Short English label, used for the dial title and the PI dropdown. */
	readonly label: string;
	/** Shorter form for the Next/Previous Value key title, where `label` would be clipped. */
	readonly shortLabel?: string;
	readonly kind: UnitKind;
	/** The measurement read from `ModuleData.values`. */
	readonly source: MetricKey;
	/** Trend measurement (+1 / 0 / -1), where the API reports one. */
	readonly trend?: MetricKey;
	/** Today's extremes, where the API reports them. */
	readonly min?: MetricKey;
	readonly max?: MetricKey;
	/** Direction measurement for wind-like metrics (degrees). */
	readonly angle?: MetricKey;
	readonly glyph: GlyphName;
	/**
	 * Span mapped to 0..100 % on the dial's indicator bar, in the API's metric unit.
	 * UX choice (the bar should move visibly in everyday weather), not a scientific scale.
	 */
	readonly gauge: { readonly min: number; readonly max: number };
}

export const METRICS: Readonly<Record<DisplayMetricId, MetricDef>> = {
	temperature: {
		id: "temperature",
		label: "Temperature",
		kind: "temperature",
		source: "temperature",
		trend: "tempTrend",
		min: "tempMin",
		max: "tempMax",
		glyph: "thermometer",
		gauge: { min: -20, max: 40 },
	},
	humidity: { id: "humidity", label: "Humidity", kind: "percent", source: "humidity", glyph: "droplets", gauge: { min: 0, max: 100 } },
	co2: { id: "co2", label: "CO2", kind: "ppm", source: "co2", glyph: "leaf", gauge: { min: 400, max: 2000 } },
	noise: { id: "noise", label: "Noise", kind: "decibel", source: "noise", glyph: "volume-2", gauge: { min: 30, max: 90 } },
	pressure: {
		id: "pressure",
		label: "Pressure",
		kind: "pressure",
		source: "pressure",
		trend: "pressureTrend",
		glyph: "gauge",
		gauge: { min: 960, max: 1060 },
	},
	// Netatmo reports two pressure values per base station ("Pressure" and "AbsolutePressure").
	// The live probe of 2026-11-13 (one elevated station; docs/WEATHER-API.md) found `Pressure`
	// larger than `AbsolutePressure`: `Pressure` is the sea-level (reduced) value, labelled
	// plainly "Pressure" as in weather reports, and `AbsolutePressure` the pressure at the
	// station's height, labelled "Station pressure". One station, but physically unambiguous.
	// Both are shown exactly as the API delivers them. Station pressure has no trend (the API
	// documents one pressure_trend and does not say which field it describes; not checked)
	// and no colour bands (the weather-map bands only make sense at sea level).
	absolutePressure: {
		id: "absolutePressure",
		label: "Station pressure",
		shortLabel: "Stn press.",
		kind: "pressure",
		source: "absolutePressure",
		glyph: "gauge",
		gauge: { min: 850, max: 1060 },
	},
	rain: { id: "rain", label: "Rain now", kind: "rain", source: "rain", glyph: "cloud-rain", gauge: { min: 0, max: 5 } },
	rain1h: { id: "rain1h", label: "Rain 1 h", kind: "rain", source: "rain1h", glyph: "cloud-rain", gauge: { min: 0, max: 20 } },
	rain24h: { id: "rain24h", label: "Rain 24 h", kind: "rain", source: "rain24h", glyph: "cloud-rain", gauge: { min: 0, max: 50 } },
	wind: { id: "wind", label: "Wind", kind: "wind", source: "windStrength", angle: "windAngle", glyph: "wind", gauge: { min: 0, max: 100 } },
	gust: { id: "gust", label: "Gusts", kind: "wind", source: "gustStrength", angle: "gustAngle", glyph: "wind", gauge: { min: 0, max: 100 } },
};

/** Order in which the dial cycles through what a module reports. */
export const DIAL_METRIC_ORDER: readonly DisplayMetricId[] = [
	"temperature",
	"humidity",
	"co2",
	"noise",
	"pressure",
	"absolutePressure",
	"rain24h",
	"rain1h",
	"rain",
	"wind",
	"gust",
];

export const DISPLAY_METRIC_IDS = Object.keys(METRICS) as DisplayMetricId[];

export function isDisplayMetricId(value: unknown): value is DisplayMetricId {
	return typeof value === "string" && Object.hasOwn(METRICS, value);
}

/** True when the module's values contain a finite number for this metric. */
export function moduleReports(values: Partial<Record<MetricKey, number>>, metric: MetricDef): boolean {
	return Number.isFinite(values[metric.source]);
}

/** Metrics a module reports, in dial order. */
export function metricsReportedBy(values: Partial<Record<MetricKey, number>>): DisplayMetricId[] {
	return DIAL_METRIC_ORDER.filter((id) => moduleReports(values, METRICS[id]));
}

/** Map a value into 0..100 for a bar; out-of-range and non-finite inputs are clamped. */
export function gaugePercent(metric: MetricDef, value: number): number {
	const { min, max } = metric.gauge;
	if (!Number.isFinite(value)) return 0;
	const pct = ((value - min) / (max - min)) * 100;
	return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * Which series Netatmo's getmeasure can deliver for a display metric. Metrics without an entry
 * (station pressure, gusts) have no history. Every rain face draws the same series: rain per bucket.
 */
export const HISTORY_METRIC: Readonly<Partial<Record<DisplayMetricId, HistoryMetric>>> = {
	temperature: "temperature",
	humidity: "humidity",
	co2: "co2",
	noise: "noise",
	pressure: "pressure",
	rain: "rain",
	rain1h: "rain",
	rain24h: "rain",
	wind: "windStrength",
};

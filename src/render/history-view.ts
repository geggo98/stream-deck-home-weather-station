/**
 * What the history key and the dial's history strip show. Pure: (state, history result,
 * clock) -> face. Status beats metadata, exactly as for the measurement keys: a signed-out
 * account or an unreachable module says so instead of drawing a curve.
 *
 * Display table of the history states:
 *   no history type for the metric        "No history"
 *   still loading                         "Loading"
 *   no points in the window               "No history"
 *   sign-in lost                          "Sign in"
 *   request budget used up                "Try later"
 *   network or server trouble             "Offline"
 *   unsupported by this module            "No history"
 */

import type { ConnectionState, HistoryRequest, HistoryResult, HistoryWindow, StationSnapshot, UnitPreferences } from "../adapter/station/types.ts";
import type { ActionSettings } from "../focus/settings.ts";
import type { GlobalSettings } from "../pi-protocol.ts";
import { accentFor, NEUTRAL_COLOUR, WARNING_COLOUR } from "./colour.ts";
import { formatMetric, joinValueUnit, resolveUnits } from "./format.ts";
import type { GlyphName } from "./glyph-names.ts";
import { statusFace } from "./key-view.ts";
import { HISTORY_METRIC, METRICS, type DisplayMetricId } from "./metrics.ts";
import { composeSparkline, type SparklineSpec } from "./sparkline.ts";
import { classify, type Classification } from "./status.ts";
import { composeTile } from "./tile.ts";
import { joinLines } from "./title.ts";

export const HISTORY_WINDOW_MS: Readonly<Record<HistoryWindow, number>> = {
	"6h": 6 * 3_600_000,
	"24h": 24 * 3_600_000,
	"3d": 72 * 3_600_000,
};

export const HISTORY_WINDOW_LABEL: Readonly<Record<HistoryWindow, string>> = { "6h": "6 h", "24h": "24 h", "3d": "3 days" };

const FALLBACK_PREFERENCES: UnitPreferences = { unitSystem: "metric", windUnit: "kmh", pressureUnit: "mbar" };
const HISTORY_GLYPH: GlyphName = "chart-line";

export interface HistoryViewInput {
	readonly metric: DisplayMetricId;
	readonly settings: ActionSettings;
	readonly global: GlobalSettings;
	readonly hasSource: boolean;
	readonly connection: ConnectionState;
	readonly snapshot: StationSnapshot | undefined;
	readonly now: number;
	readonly window: HistoryWindow;
	/** undefined = not fetched yet (loading). */
	readonly result: HistoryResult | undefined;
	/** Replace the tile by a bare chart (the dial's strip). */
	readonly strip?: { readonly width: number; readonly height: number };
}

export interface HistoryView {
	/** Raw SVG; wrap with `svgToDataUri`. */
	readonly svg: string;
	readonly title: string | undefined;
	readonly classification: Classification;
	/** True when `svg` is a chart (not a status face). */
	readonly chart: boolean;
}

/** The request for what a face points at, or undefined when the metric has no history. */
export function historyRequestFor(
	selected: { readonly station: { readonly id: string }; readonly module: { readonly id: string } },
	metric: DisplayMetricId,
	window: HistoryWindow,
): HistoryRequest | undefined {
	const historyMetric = HISTORY_METRIC[metric];
	if (!historyMetric) return undefined;
	return { stationId: selected.station.id, moduleId: selected.module.id, metric: historyMetric, window };
}

/** The key for "same request" comparisons. */
export function historyRequestKey(request: HistoryRequest): string {
	return `${request.stationId}|${request.moduleId}|${request.metric}|${request.window}`;
}

function plain(glyph: GlyphName, title: string, strip: HistoryViewInput["strip"], status: "idle" | "warn", classification: Classification): HistoryView {
	if (strip) {
		// A strip has no tile: an empty chart area and the words in the title line.
		const svg = composeSparkline({ points: [], stepMs: 1, windowStart: 0, windowEnd: 1, accent: NEUTRAL_COLOUR, dim: true, size: { ...strip, tile: false } });
		return { svg, title, classification, chart: false };
	}
	return { svg: composeTile({ glyph, accent: status === "warn" ? WARNING_COLOUR : NEUTRAL_COLOUR, dim: status === "idle", status }), title, classification, chart: false };
}

export function buildHistoryView(input: HistoryViewInput): HistoryView {
	const def = METRICS[input.metric];
	const classification = classify({
		hasSource: input.hasSource,
		connection: input.connection,
		snapshot: input.snapshot,
		moduleKey: input.settings.moduleKey,
		metric: input.metric,
		now: input.now,
	});
	const status = statusFace(classification, HISTORY_GLYPH);
	if (status) {
		return input.strip
			? plain(HISTORY_GLYPH, status.title, input.strip, "idle", classification)
			: { svg: status.svg, title: status.title, classification, chart: false };
	}
	if (classification.kind !== "value") throw new Error("unreachable: statusFace covers every non-value");

	if (!HISTORY_METRIC[input.metric]) return plain(HISTORY_GLYPH, "No history", input.strip, "idle", classification);
	const result = input.result;
	if (!result) return plain(HISTORY_GLYPH, "Loading", input.strip, "idle", classification);
	if (result.kind === "error") {
		switch (result.reason) {
			case "auth":
				return plain(HISTORY_GLYPH, "Sign in", input.strip, "warn", classification);
			case "rate":
				return plain(HISTORY_GLYPH, "Try later", input.strip, "warn", classification);
			case "transient":
				return plain(HISTORY_GLYPH, "Offline", input.strip, "warn", classification);
			default:
				return plain(HISTORY_GLYPH, "No history", input.strip, "idle", classification);
		}
	}
	const points = result.points.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t));
	if (points.length === 0) return plain(HISTORY_GLYPH, "No history", input.strip, "idle", classification);

	const units = resolveUnits(input.settings.unitSystem, input.global.unitSystem, input.snapshot?.preferences ?? FALLBACK_PREFERENCES);
	const bars = result.request.metric === "rain";
	// Quantise the end of the time axis to the bucket length: the axis then moves once per
	// bucket, not once per repaint, and an unchanged series gives an unchanged image.
	const step = Math.max(result.stepMs, 1);
	const windowEnd = Math.ceil(input.now / step) * step;
	const windowStart = windowEnd - HISTORY_WINDOW_MS[input.window];
	const newest = points.reduce((a, b) => (b.t > a.t ? b : a));
	const spec: SparklineSpec = {
		points,
		stepMs: step,
		windowStart,
		windowEnd,
		bars,
		accent: accentFor(input.metric, bars ? points.reduce((sum, p) => sum + p.v, 0) : newest.v),
		dim: classification.stale,
		notice: classification.warning && !classification.stale,
		size: input.strip ? { ...input.strip, tile: false } : undefined,
	};
	const windowLabel = HISTORY_WINDOW_LABEL[input.window];
	let detail: string;
	if (bars) {
		const total = points.reduce((sum, p) => sum + p.v, 0);
		detail = `Σ ${joinValueUnit(formatMetric(def, total, units))}`;
	} else {
		const lo = formatMetric(def, Math.min(...points.map((p) => p.v)), units);
		const hi = formatMetric(def, Math.max(...points.map((p) => p.v)), units);
		detail = `↓${lo.text} ↑${joinValueUnit(hi)}`;
	}
	return { svg: composeSparkline(spec), title: joinLines([windowLabel, detail]), classification, chart: true };
}

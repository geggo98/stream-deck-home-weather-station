/**
 * Everything a key shows, computed in one pure function: (state, settings, clock) -> view.
 *
 * Both the data path and the status path go through here, so what a key displays when
 * data is old or missing is recomputed on every repaint and cannot get stuck.
 */

import type { ConnectionState, StationSnapshot, UnitPreferences } from "../adapter/station/types.ts";
import type { GlobalSettings } from "../pi-protocol.ts";
import type { ActionSettings } from "../focus/settings.ts";
import { accentFor, ERROR_COLOUR, NEUTRAL_COLOUR, WARNING_COLOUR } from "./colour.ts";
import { alertOf } from "../focus/settings.ts";
import { compassPoint, formatMetric, joinValueUnit, resolveUnits } from "./format.ts";
import type { GlyphName } from "./glyph-names.ts";
import { METRICS, type DisplayMetricId } from "./metrics.ts";
import { classify, formatAge, type Classification } from "./status.ts";
import { composeTile, type TileSpec, type Trend } from "./tile.ts";
import { cleanLabel, joinLines, minMaxLine, statusWord } from "./title.ts";

export interface KeyViewInput {
	readonly metric: DisplayMetricId;
	readonly settings: ActionSettings;
	readonly global: GlobalSettings;
	readonly hasSource: boolean;
	readonly connection: ConnectionState;
	readonly snapshot: StationSnapshot | undefined;
	readonly now: number;
	/** Show today's min/max instead of the value (temperature only; ignored otherwise). */
	readonly overlay?: boolean;
	/** The key follows the focus: its "No data" face keeps the name of the sensor it landed on. */
	readonly followed?: boolean;
}

export interface KeyView {
	/** Raw SVG; wrap with `svgToDataUri` before `setImage`. */
	readonly svg: string;
	/** Native title; undefined = no text (Stream Deck then shows the title from the manifest). */
	readonly title: string | undefined;
	readonly classification: Classification;
}

const FALLBACK_PREFERENCES: UnitPreferences = { unitSystem: "metric", windUnit: "kmh", pressureUnit: "mbar" };

function trendOf(value: number | undefined): Trend | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value > 0 ? "up" : value < 0 ? "down" : "stable";
}

interface StatusFace {
	readonly glyph: GlyphName;
	readonly accent: string;
	readonly dim: boolean;
	readonly status: TileSpec["status"];
}

export function faceForStatus(kind: Exclude<Classification["kind"], "value" | "unreachable" | "no-data">): StatusFace {
	switch (kind) {
		case "no-credentials":
			return { glyph: "settings", accent: NEUTRAL_COLOUR, dim: false, status: "idle" };
		case "auth-error":
			return { glyph: "triangle-alert", accent: WARNING_COLOUR, dim: false, status: "warn" };
		case "loading":
			return { glyph: "loader", accent: NEUTRAL_COLOUR, dim: false, status: "idle" };
		case "offline":
		case "no-service":
			return { glyph: "wifi-off", accent: NEUTRAL_COLOUR, dim: true, status: "warn" };
		case "no-module":
			return { glyph: "circle-help", accent: NEUTRAL_COLOUR, dim: false, status: "idle" };
	}
}

/**
 * The face of every state that is not a value (status words, unreachable, no data), shared by
 * the measurement keys and the history key. undefined for a value. `glyph` is what an
 * unreachable module or a missing measurement keeps showing, dimmed.
 */
export function statusFace(classification: Classification, glyph: GlyphName): { svg: string; title: string } | undefined {
	return classification.kind === "value" ? undefined : statusFaceOf(classification.kind, glyph);
}

/** `statusFace` for a kind that is known not to be a value: always a face. */
export function statusFaceOf(kind: Exclude<Classification["kind"], "value">, glyph: GlyphName): { svg: string; title: string } {
	if (kind === "unreachable" || kind === "no-data") {
		return {
			svg: composeTile({ glyph, accent: NEUTRAL_COLOUR, dim: true, status: kind === "unreachable" ? "warn" : "idle" }),
			title: statusWord(kind),
		};
	}
	const face = faceForStatus(kind);
	return {
		svg: composeTile({ glyph: face.glyph, accent: face.accent, dim: face.dim, status: face.status }),
		title: statusWord(kind),
	};
}

/** True when the displayed value is outside the key's thresholds (compared in display units, as typed). */
export function isAlerting(displayValue: number, settings: ActionSettings): boolean {
	const { above, below } = alertOf(settings);
	return (above !== undefined && displayValue > above) || (below !== undefined && displayValue < below);
}

export function buildKeyView(input: KeyViewInput): KeyView {
	const def = METRICS[input.metric];
	const classification = classify({
		hasSource: input.hasSource,
		connection: input.connection,
		snapshot: input.snapshot,
		moduleKey: input.settings.moduleKey,
		metric: input.metric,
		now: input.now,
	});
	const status = statusFace(classification, def.glyph);
	if (status) {
		// A following key says which sensor lacks the value: the focus, not the user, put it there.
		const where = input.followed === true && classification.kind === "no-data"
			? cleanLabel(classification.selected.module.name)
			: "";
		return { svg: status.svg, title: where ? joinLines([status.title, where]) : status.title, classification };
	}
	if (classification.kind !== "value") throw new Error("unreachable: statusFace covers every non-value");

	const { selected, value, stale, ageMs, warning } = classification;
	const units = resolveUnits(
		input.settings.unitSystem,
		input.global.unitSystem,
		input.snapshot?.preferences ?? FALLBACK_PREFERENCES,
	);
	const formatted = formatMetric(def, value, units);
	// Alert thresholds are compared with the DISPLAYED number (display units, rounded), so what
	// the user reads is what trips the alert. The alert colour is static: no blinking.
	const alert = isAlerting(formatted.rounded, input.settings);
	// Colour from the metric value rounded to the displayed precision: see colour.ts.
	const accent = alert ? ERROR_COLOUR : accentFor(input.metric, value);
	const values = selected.module.values;

	const min = def.min ? values[def.min] : undefined;
	const max = def.max ? values[def.max] : undefined;
	const hasMinMax = typeof min === "number" && Number.isFinite(min) && typeof max === "number" && Number.isFinite(max);
	const trend = input.settings.showTrend === true && def.trend ? trendOf(values[def.trend]) : undefined;
	// "notice" (unsaved sign-in) is a dot only: the value stays at full strength. Staleness wins when both apply.
	const tileStatus: TileSpec["status"] = stale ? "stale" : warning ? "notice" : "ok";

	// Overlay: today's extremes instead of the value. Status beats metadata, so it is only
	// reachable here, i.e. never while a status word has taken over.
	if (input.overlay === true && hasMinMax) {
		const lo = joinValueUnit(formatMetric(def, min, units));
		const hi = joinValueUnit(formatMetric(def, max, units));
		return {
			svg: composeTile({ glyph: def.glyph, accent, dim: stale, minMaxHint: true, status: tileStatus }),
			title: `↑${hi}\n↓${lo}`,
			classification,
		};
	}

	const label = cleanLabel(input.settings.label);
	const angle = def.angle ? values[def.angle] : undefined;
	const compass = typeof angle === "number" ? compassPoint(angle) : undefined;
	const secondLine = stale && ageMs !== undefined
		? formatAge(ageMs)
		: label || compass || cleanLabel(selected.module.name);
	const minMax = input.settings.showMinMax === true && hasMinMax
		? minMaxLine(formatMetric(def, min, units).rounded, formatMetric(def, max, units).rounded)
		: undefined;
	const showHint = input.settings.showMinMax === true && hasMinMax;

	const bigText = input.settings.bigText === true;
	const svg = composeTile({
		glyph: def.glyph,
		accent,
		dim: stale,
		trend,
		minMaxHint: showHint,
		status: tileStatus,
		alert,
		bigText: bigText ? { value: formatted.text, unit: formatted.unit } : undefined,
	});
	const title = joinLines([bigText ? undefined : joinValueUnit(formatted), secondLine, minMax]);
	return { svg, title, classification };
}

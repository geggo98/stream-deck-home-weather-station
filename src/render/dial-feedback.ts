/**
 * Touch-strip content for the dial, built for the built-in `$B1` layout
 * (icon + title + value + indicator bar). Pure.
 *
 * Rules inherited from the sibling project's hardware measurements (not re-measured here):
 *  - Every item gets an EXPLICIT opacity, including 1: a layout keeps what it was last
 *    given, so "back to normal" has to be stated or a dimmed strip stays dimmed.
 *  - An icon cannot be unset, only overwritten; we write the glyph for the current face
 *    every time, so there is nothing left over to unset.
 *  - Opacity accepts one decimal only.
 * The `$B1` item keys (`icon`, `title`, `value`, `indicator`) are taken from Elgato's
 * documentation of built-in layouts; an unknown key is silently ignored by Stream Deck.
 */

import type { ConnectionState, StationSnapshot, UnitPreferences } from "../adapter/station/types.ts";
import type { GlobalSettings } from "../pi-protocol.ts";
import type { ActionSettings } from "../focus/settings.ts";
import { accentFor, NEUTRAL_COLOUR } from "./colour.ts";
import { svgToDataUri } from "./data-uri.ts";
import { formatMetric, joinValueUnit, resolveUnits } from "./format.ts";
import { gaugePercent, METRICS, type DisplayMetricId } from "./metrics.ts";
import { classify, formatAge } from "./status.ts";
import { buildHistoryView, type HistoryViewInput } from "./history-view.ts";
import { composeDialIcon } from "./tile.ts";
import { cleanLabel, MAX_DIAL_LABEL_CHARS, statusWord } from "./title.ts";

export type Opacity = 0 | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 | 1;

/** Opacity of a strip that shows old or missing data. */
export const DIM_OPACITY: Opacity = 0.4;

export type DialFeedbackPayload = {
	icon: { value: string; opacity: Opacity };
	title: { value: string; opacity: Opacity };
	value: { value: string; opacity: Opacity };
	indicator: { value: number; opacity: Opacity; bar_fill_c: string };
};

/** The item keys the payload writes; a test checks them against the `$B1` layout contract. */
export const DIAL_ITEM_KEYS = ["icon", "title", "value", "indicator"] as const;

export interface DialViewInput {
	readonly metric: DisplayMetricId;
	readonly settings: ActionSettings;
	readonly global: GlobalSettings;
	readonly hasSource: boolean;
	readonly connection: ConnectionState;
	readonly snapshot: StationSnapshot | undefined;
	readonly now: number;
	/** Touch toggled min/max for the temperature face. */
	readonly showMinMax: boolean;
}

/** Custom layout of the history strip (layouts/history-strip.json); the dial switches to it and back to `$B1`. */
export const HISTORY_LAYOUT = "layouts/history-strip.json";
export const BUILT_IN_LAYOUT = "$B1";
/** The item keys that layout declares; a test compares them with the file. */
export const HISTORY_ITEM_KEYS = ["title", "chart", "value"] as const;
/** Size of the strip's chart item, as in the layout file. */
export const HISTORY_CHART_SIZE = { width: 184, height: 52 } as const;

export type HistoryStripPayload = {
	title: { value: string; opacity: Opacity };
	chart: { value: string; opacity: Opacity };
	value: { value: string; opacity: Opacity };
};

/** The strip's content: a 24 h (or other window) mini history drawn as an image item. */
export function buildHistoryStrip(input: Omit<HistoryViewInput, "strip">): HistoryStripPayload {
	const view = buildHistoryView({ ...input, strip: HISTORY_CHART_SIZE });
	const def = METRICS[input.metric];
	const opacity: Opacity = view.classification.kind === "value" && !view.classification.stale ? 1 : DIM_OPACITY;
	const lines = (view.title ?? "").split("\n");
	return {
		title: { value: cleanLabel(input.settings.label, MAX_DIAL_LABEL_CHARS) || def.label, opacity },
		chart: { value: svgToDataUri(view.svg), opacity },
		value: { value: lines.join(" · "), opacity },
	};
}

const FALLBACK_PREFERENCES: UnitPreferences = { unitSystem: "metric", windUnit: "kmh", pressureUnit: "mbar" };

const TREND_ARROW = { up: "↑", down: "↓", stable: "→" } as const;

export function buildDialFeedback(input: DialViewInput): DialFeedbackPayload {
	const def = METRICS[input.metric];
	const c = classify({
		hasSource: input.hasSource,
		connection: input.connection,
		snapshot: input.snapshot,
		moduleKey: input.settings.moduleKey,
		metric: input.metric,
		now: input.now,
	});
	const baseTitle = cleanLabel(input.settings.label, MAX_DIAL_LABEL_CHARS) || def.label;

	if (c.kind !== "value") {
		return {
			icon: { value: svgToDataUri(composeDialIcon(def.glyph, NEUTRAL_COLOUR, true)), opacity: DIM_OPACITY },
			title: { value: baseTitle, opacity: DIM_OPACITY },
			value: { value: statusWord(c.kind), opacity: DIM_OPACITY },
			indicator: { value: 0, opacity: DIM_OPACITY, bar_fill_c: NEUTRAL_COLOUR },
		};
	}

	const units = resolveUnits(
		input.settings.unitSystem,
		input.global.unitSystem,
		input.snapshot?.preferences ?? FALLBACK_PREFERENCES,
	);
	const values = c.selected.module.values;
	const accent = accentFor(input.metric, c.value);
	const min = def.min ? values[def.min] : undefined;
	const max = def.max ? values[def.max] : undefined;
	const minMaxAvailable = typeof min === "number" && Number.isFinite(min) && typeof max === "number" && Number.isFinite(max);

	let valueText: string;
	if (input.showMinMax && minMaxAvailable) {
		valueText = `↓${joinValueUnit(formatMetric(def, min, units))} ↑${joinValueUnit(formatMetric(def, max, units))}`;
	} else {
		valueText = joinValueUnit(formatMetric(def, c.value, units));
		const trendValue = input.settings.showTrend === true && def.trend ? values[def.trend] : undefined;
		if (typeof trendValue === "number" && Number.isFinite(trendValue)) {
			valueText += ` ${TREND_ARROW[trendValue > 0 ? "up" : trendValue < 0 ? "down" : "stable"]}`;
		}
	}

	const opacity: Opacity = c.stale ? DIM_OPACITY : 1;
	const title = c.stale && c.ageMs !== undefined ? `${baseTitle} · ${formatAge(c.ageMs)}` : baseTitle;
	return {
		icon: { value: svgToDataUri(composeDialIcon(def.glyph, accent, c.stale)), opacity },
		title: { value: title, opacity },
		value: { value: valueText, opacity },
		indicator: { value: gaugePercent(def, c.value), opacity, bar_fill_c: accent },
	};
}

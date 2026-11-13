/**
 * Sparkline of a history series as an SVG string. Pure.
 *
 * Shapes only, no text: min/max and the window go through the native key title, so no API
 * string and no font handling is involved. Coordinates are rounded to whole pixels (and the
 * caller quantises the window end to the bucket length), so a repaint with unchanged data
 * produces the same string and image de-duplication holds.
 *
 *  - gaps are drawn as gaps: neighbouring points more than two buckets apart are not joined;
 *  - a lone point is a dot, a flat series a horizontal line in the middle;
 *  - rain (`bars`) is drawn as one bar per bucket on a zero baseline.
 *
 * The result is RAW markup: wrap with `svgToDataUri` before it goes to `setImage`.
 */

import type { HistoryPoint } from "../adapter/station/types.ts";
import { mixColour, safeColour, scaleColour, WARNING_COLOUR } from "./colour.ts";
import { DIM_FACTOR, TILE_SIZE } from "./tile.ts";

export interface SparklineSpec {
	readonly points: readonly HistoryPoint[];
	/** Bucket length in ms; joins and bar widths follow from it. */
	readonly stepMs: number;
	/** Time axis, epoch ms. Quantise `windowEnd` to the bucket length before calling. */
	readonly windowStart: number;
	readonly windowEnd: number;
	readonly bars?: boolean;
	/**
	 * What a point's `t` denotes: "middle" (default) = the middle of its bucket, which is what the
	 * API reports with real_time=false ("offset + scale/2"; seen live for scale 30min); "start" = the bucket's
	 * first instant. Lines are drawn through the bucket middle, bars span the whole bucket.
	 */
	readonly bucketAnchor?: "start" | "middle";
	readonly accent: string;
	readonly dim?: boolean;
	/** A warning-coloured dot in the corner, without dimming: the data is current but needs attention (see TileStatus "notice"). */
	readonly notice?: boolean;
	/** A 144x144 key tile with rounded background (default) or a bare chart of `width` x `height` for a strip. */
	readonly size?: { readonly width: number; readonly height: number; readonly tile: boolean };
}

const TILE_BACKGROUND = "#16191D";
const BASELINE = "#3A4048";
/** Neighbours further apart than this many buckets are not connected. */
export const MAX_JOIN_STEPS = 2;

interface Box {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

function num(n: number): string {
	return String(Math.round(n));
}

export function composeSparkline(spec: SparklineSpec): string {
	const svg = composeChart(spec);
	if (spec.notice !== true) return svg;
	const tile = spec.size?.tile ?? true;
	const width = spec.size?.width ?? TILE_SIZE;
	const dot = tile ? `<circle cx="14" cy="14" r="6" fill="${WARNING_COLOUR}"/>` : `<circle cx="${width - 6}" cy="6" r="4" fill="${WARNING_COLOUR}"/>`;
	return svg.replace(/<\/svg>$/, `${dot}</svg>`);
}

function composeChart(spec: SparklineSpec): string {
	const size = spec.size ?? { width: TILE_SIZE, height: TILE_SIZE, tile: true };
	const accent = spec.dim ? scaleColour(safeColour(spec.accent), DIM_FACTOR) : safeColour(spec.accent);
	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`,
	];
	// Chart area: on a tile, leave the lower part to the native title.
	const box: Box = size.tile
		? { left: 12, top: 14, width: size.width - 24, height: 76 }
		: { left: 2, top: 3, width: size.width - 4, height: size.height - 8 };
	if (size.tile) {
		parts.push(`<rect width="${size.width}" height="${size.height}" rx="18" fill="${mixColour(TILE_BACKGROUND, accent, 0.14)}"/>`);
	}
	const bottom = box.top + box.height;
	parts.push(`<path d="M${num(box.left)} ${num(bottom)}H${num(box.left + box.width)}" stroke="${BASELINE}" stroke-width="2" fill="none"/>`);

	const span = spec.windowEnd - spec.windowStart;
	const clean = spec.points
		.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.t >= spec.windowStart - spec.stepMs && p.t <= spec.windowEnd + spec.stepMs / 2)
		.slice()
		.sort((a, b) => a.t - b.t);
	if (clean.length === 0 || !(span > 0)) {
		parts.push("</svg>");
		return parts.join("");
	}

	const middleOf = (t: number): number => (spec.bucketAnchor === "start" ? t + Math.max(spec.stepMs, 1) / 2 : t);
	const xOf = (t: number): number => box.left + Math.max(0, Math.min(1, (t - spec.windowStart) / span)) * box.width;
	let lo = Math.min(...clean.map((p) => p.v));
	let hi = Math.max(...clean.map((p) => p.v));

	if (spec.bars) {
		lo = 0;
		hi = Math.max(hi, 0);
		const barWidth = Math.max(1, Math.round((box.width * Math.max(spec.stepMs, 1)) / span) - 1);
		const rects: string[] = [];
		for (const p of clean) {
			if (!(p.v > 0) || hi <= 0) continue;
			const h = Math.max(1, Math.round((p.v / hi) * (box.height - 2)));
			rects.push(`<rect x="${num(xOf(middleOf(p.t) - Math.max(spec.stepMs, 1) / 2))}" y="${num(bottom - h)}" width="${barWidth}" height="${h}" rx="1"/>`);
		}
		if (rects.length > 0) parts.push(`<g fill="${accent}">${rects.join("")}</g>`);
		parts.push("</svg>");
		return parts.join("");
	}

	const flat = hi - lo < 1e-9;
	const yOf = (v: number): number => (flat ? box.top + box.height / 2 : bottom - ((v - lo) / (hi - lo)) * (box.height - 2) - 1);
	const joinGap = Math.max(spec.stepMs, 1) * MAX_JOIN_STEPS;

	// Split into runs at gaps, quantise, and drop consecutive duplicates.
	const runs: Array<Array<[number, number]>> = [];
	let previousT: number | undefined;
	for (const p of clean) {
		const pt: [number, number] = [Math.round(xOf(middleOf(p.t))), Math.round(yOf(p.v))];
		if (previousT === undefined || p.t - previousT > joinGap) runs.push([pt]);
		else {
			const run = runs[runs.length - 1]!;
			const last = run[run.length - 1]!;
			if (last[0] !== pt[0] || last[1] !== pt[1]) run.push(pt);
		}
		previousT = p.t;
	}

	const dots: string[] = [];
	const paths: string[] = [];
	for (const run of runs) {
		if (run.length === 1) dots.push(`<circle cx="${run[0]![0]}" cy="${run[0]![1]}" r="3"/>`);
		else paths.push(`M${run.map(([x, y]) => `${x} ${y}`).join("L")}`);
	}
	if (paths.length > 0) {
		parts.push(`<path d="${paths.join("")}" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);
	}
	const lastRun = runs[runs.length - 1]!;
	const end = lastRun[lastRun.length - 1]!;
	dots.push(`<circle cx="${end[0]}" cy="${end[1]}" r="4"/>`);
	parts.push(`<g fill="${accent}">${dots.join("")}</g>`);
	parts.push("</svg>");
	return parts.join("");
}

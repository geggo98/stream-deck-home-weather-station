/**
 * 144x144 key tile as an SVG string. Pure.
 *
 * Composition: dark background tinted with the accent, one big glyph, optional trend
 * arrow (top right), optional min/max hint (top left), optional status dot, and an
 * optional big value text. The value normally goes through the native key title, so the
 * tile carries no text at all unless `bigText` is requested.
 *
 * Safety: no API string ever enters the markup. Colours must be `#rrggbb` (validated),
 * glyphs come from a generated table of static Lucide paths, numbers are formatted by us.
 * The only text is `bigText`, which is XML-escaped anyway.
 *
 * The result is a RAW svg string. It must be wrapped by `svgToDataUri` before it goes to
 * `setImage`: a raw SVG string is silently ignored for composed images (measured on
 * hardware in the sibling project this plugin's structure is derived from).
 */

import { GLYPHS } from "./generated/glyphs.ts";
import type { GlyphName } from "./glyph-names.ts";
import { mixColour, safeColour, scaleColour, ERROR_COLOUR, WARNING_COLOUR } from "./colour.ts";

export const TILE_SIZE = 144;

/** Share of the accent colour that survives in a dimmed tile. */
export const DIM_FACTOR = 0.4;
const BACKGROUND = "#16191D";
/** How much accent bleeds into the background. */
const BACKGROUND_TINT = 0.14;
const IDLE_DOT = "#8A929B";

/**
 * "notice" = the data is current and fully readable, but something needs attention (the renewed
 * sign-in could not be saved): a warning-coloured dot WITHOUT dimming, unlike "stale".
 */
export type TileStatus = "ok" | "stale" | "notice" | "warn" | "idle";
export type Trend = "up" | "down" | "stable";

export interface TileSpec {
	readonly glyph: GlyphName;
	readonly accent: string;
	readonly dim?: boolean;
	readonly trend?: Trend;
	/** Small up/down-to-line pair signalling that min/max is available. */
	readonly minMaxHint?: boolean;
	readonly status?: TileStatus;
	/** The value is outside the key's alert thresholds: a static border (no blinking, an accessibility risk). */
	readonly alert?: boolean;
	/**
	 * Draw the value as SVG text. EXPERIMENTAL: text in a composed image depends on the
	 * Stream Deck renderer's font handling, which has not been verified on hardware.
	 */
	readonly bigText?: { readonly value: string; readonly unit: string };
}

export function escapeXml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => {
		switch (ch) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

/** Lucide glyph (24-unit space) drawn into a box at (x, y) of the given size. */
export function glyphGroup(name: GlyphName, x: number, y: number, size: number, stroke: string): string {
	const markup = GLYPHS[name] ?? "";
	const scale = (size / 24).toFixed(4);
	return (
		`<g transform="translate(${x},${y}) scale(${scale})" fill="none" stroke="${safeColour(stroke)}" ` +
		`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${markup}</g>`
	);
}

function trendGlyph(trend: Trend): GlyphName {
	return trend === "up" ? "arrow-up" : trend === "down" ? "arrow-down" : "arrow-right";
}

function statusDotColour(status: TileStatus, dim: boolean): string {
	const base = status === "warn" ? ERROR_COLOUR : status === "stale" || status === "notice" ? WARNING_COLOUR : IDLE_DOT;
	// The dot is the one thing that must stay readable on a dimmed tile.
	return dim ? scaleColour(base, 0.85) : base;
}

/** Largest font size (px) that keeps `chars` characters inside `width` px; ~0.6 em per digit. */
export function fitFontSize(chars: number, width: number, max: number): number {
	if (chars <= 0) return max;
	return Math.max(12, Math.min(max, Math.floor(width / (0.6 * chars))));
}

export function composeTile(spec: TileSpec): string {
	const dim = spec.dim === true;
	const accent = dim ? scaleColour(safeColour(spec.accent), DIM_FACTOR) : safeColour(spec.accent);
	const background = mixColour(BACKGROUND, accent, BACKGROUND_TINT);
	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_SIZE}" height="${TILE_SIZE}" viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}">`,
		`<rect width="${TILE_SIZE}" height="${TILE_SIZE}" rx="18" fill="${background}"/>`,
	];

	if (spec.alert) {
		parts.push(`<rect x="3" y="3" width="${TILE_SIZE - 6}" height="${TILE_SIZE - 6}" rx="16" fill="none" stroke="${ERROR_COLOUR}" stroke-width="6"/>`);
	}

	if (spec.bigText) {
		parts.push(glyphGroup(spec.glyph, 48, 8, 48, accent));
		const value = escapeXml(spec.bigText.value);
		const size = fitFontSize(spec.bigText.value.length, 124, 52);
		parts.push(
			`<text x="72" y="104" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${size}" fill="${dim ? scaleColour("#FFFFFF", 0.6) : "#FFFFFF"}">${value}</text>`,
			`<text x="72" y="130" text-anchor="middle" font-family="sans-serif" font-weight="400" font-size="20" fill="${accent}">${escapeXml(spec.bigText.unit)}</text>`,
		);
	} else {
		parts.push(glyphGroup(spec.glyph, 32, 16, 80, accent));
	}

	if (spec.trend) {
		parts.push(glyphGroup(trendGlyph(spec.trend), 108, 6, 30, dim ? accent : "#FFFFFF"));
	}
	if (spec.minMaxHint) {
		const hint = dim ? accent : "#C8CDD3";
		parts.push(glyphGroup("arrow-up-to-line", 28, 6, 20, hint), glyphGroup("arrow-down-to-line", 50, 6, 20, hint));
	}
	if (spec.status && spec.status !== "ok") {
		parts.push(`<circle cx="14" cy="14" r="6" fill="${statusDotColour(spec.status, dim)}"/>`);
	}
	parts.push("</svg>");
	return parts.join("");
}

/** 48x48 icon for the dial's touch strip icon slot (no background: the strip provides one). */
export function composeDialIcon(glyph: GlyphName, accent: string, dim = false): string {
	const stroke = dim ? scaleColour(safeColour(accent), DIM_FACTOR) : safeColour(accent);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">` +
		`${glyphGroup(glyph, 4, 4, 40, stroke)}</svg>`
	);
}

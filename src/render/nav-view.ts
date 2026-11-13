/**
 * Faces of the navigation and utility keys of the focus family (reload, next/previous
 * value, sensor and station, auto rotate, data age and battery). Pure.
 *
 * The next/previous keys show what a press WOULD select, so the key is a preview, and they
 * are dimmed when pressing would change nothing (`blocked`). Status beats everything:
 * a signed-out account shows the same status faces as the measurement keys.
 */

import type { ConnectionState, ModuleData, ModuleRole, StationSnapshot } from "../adapter/station/types.ts";
import { locate, nextMetric, nextModule, nextStation, type Direction, type Focus, type NavResult } from "../focus/navigate.ts";
import { ERROR_COLOUR, NEUTRAL_COLOUR, WARNING_COLOUR } from "./colour.ts";
import type { GlyphName } from "./glyph-names.ts";
import { statusFaceOf } from "./key-view.ts";
import { METRICS } from "./metrics.ts";
import { displayMetricOf } from "../focus/navigate.ts";
import { classifyConnection, formatAgeLong, hasCachedError, hasWarning, STALE_AFTER_MS } from "./status.ts";
import { composeTile, type TileStatus } from "./tile.ts";
import { cleanLabel, joinLines } from "./title.ts";

export const NAV_KINDS = [
	"refresh",
	"next-metric",
	"prev-metric",
	"next-sensor",
	"prev-sensor",
	"next-station",
	"prev-station",
	"auto-rotate",
	"info",
] as const;

export type NavKind = (typeof NAV_KINDS)[number];

export function isNavKind(value: unknown): value is NavKind {
	return typeof value === "string" && (NAV_KINDS as readonly string[]).includes(value);
}

export type InfoPage = "age" | "battery";

export interface NavViewInput {
	readonly kind: NavKind;
	readonly hasSource: boolean;
	readonly connection: ConnectionState;
	readonly snapshot: StationSnapshot | undefined;
	/** The resolved focus (see `resolveFocus`), undefined when there is nothing to focus on. */
	readonly focus: Focus | undefined;
	readonly now: number;
	/** A reload is in flight. */
	readonly refreshing?: boolean;
	readonly autoRotateOn?: boolean;
	readonly autoRotateSeconds?: number;
	readonly infoPage?: number;
}

export interface NavView {
	/** Raw SVG; wrap with `svgToDataUri`. */
	readonly svg: string;
	readonly title: string | undefined;
	/** Pressing would change nothing (nothing to navigate to); the face is dimmed. */
	readonly blocked: boolean;
}

const NAV_ACCENT = "#6FA8DC";
const ON_ACCENT = "#58C97A";

const DIRECTION: Readonly<Record<NavKind, Direction | undefined>> = {
	"refresh": undefined,
	"next-metric": 1,
	"prev-metric": -1,
	"next-sensor": 1,
	"prev-sensor": -1,
	"next-station": 1,
	"prev-station": -1,
	"auto-rotate": undefined,
	"info": undefined,
};

const KIND_GLYPH: Readonly<Record<NavKind, GlyphName>> = {
	"refresh": "refresh-cw",
	"next-metric": "step-forward",
	"prev-metric": "step-back",
	"next-sensor": "circle-arrow-right",
	"prev-sensor": "circle-arrow-left",
	"next-station": "chevrons-right",
	"prev-station": "chevrons-left",
	"auto-rotate": "repeat",
	"info": "info",
};

const ROLE_GLYPH: Readonly<Record<ModuleRole, GlyphName>> = {
	"base": "house",
	"outdoor": "sun",
	"wind": "wind",
	"rain": "cloud-rain",
	"indoor-extra": "door-open",
};

const ARROW = { 1: "→", [-1]: "←" } as const;

/** The result of the navigation a navigation key would perform; undefined for the other keys. */
export function navigationPreview(kind: NavKind, snapshot: StationSnapshot | undefined, focus: Focus | undefined): NavResult | undefined {
	const dir = DIRECTION[kind];
	if (dir === undefined || !focus) return undefined;
	if (kind === "next-metric" || kind === "prev-metric") return nextMetric(snapshot, focus, dir);
	if (kind === "next-sensor" || kind === "prev-sensor") return nextModule(snapshot, focus, dir);
	return nextStation(snapshot, focus, dir);
}

/** Pages the info key cycles through for a module: always the data age, the battery level where reported. */
export function infoPages(module: ModuleData | undefined): InfoPage[] {
	return module && typeof module.batteryPercent === "number" && Number.isFinite(module.batteryPercent) ? ["age", "battery"] : ["age"];
}

function batteryGlyph(percent: number): GlyphName {
	return percent > 60 ? "battery-full" : percent > 25 ? "battery-medium" : "battery-low";
}

function batteryAccent(percent: number): string {
	return percent <= 15 ? ERROR_COLOUR : percent <= 40 ? WARNING_COLOUR : ON_ACCENT;
}

function dimmed(glyph: GlyphName, title: string | undefined, blocked = true): NavView {
	return { svg: composeTile({ glyph, accent: NEUTRAL_COLOUR, dim: true, status: "idle" }), title, blocked };
}

export function buildNavView(input: NavViewInput): NavView {
	const glyph = KIND_GLYPH[input.kind];
	const overriding = classifyConnection(input.hasSource, input.connection, input.snapshot);
	if (overriding) {
		const face = statusFaceOf(overriding, glyph);
		return { svg: face.svg, title: face.title, blocked: true };
	}
	// Data is current but the renewed sign-in could not be saved: a dot on every live face, nothing dimmed.
	const okStatus: TileStatus = hasWarning(input.connection) ? "notice" : "ok";
	const snapshot = input.snapshot;
	if (!snapshot || !input.focus) return dimmed(glyph, "No data");
	const at = locate(snapshot, input.focus);

	if (input.kind === "auto-rotate") {
		return input.autoRotateOn
			? { svg: composeTile({ glyph: "repeat", accent: ON_ACCENT, status: okStatus }), title: `On\n${input.autoRotateSeconds ?? 8} s`, blocked: false }
			: { svg: composeTile({ glyph: "pause", accent: NEUTRAL_COLOUR, dim: true, status: "idle" }), title: "Off", blocked: false };
	}

	if (input.kind === "refresh" || input.kind === "info") {
		if (!at) return dimmed(glyph, "No module");
		const measuredAt = at.module.measuredAt;
		const ageMs = Math.max(0, input.now - (measuredAt ?? snapshot.fetchedAt));
		const stale = ageMs > STALE_AFTER_MS || hasCachedError(input.connection);
		const tileStatus = stale ? "stale" : okStatus;
		if (input.kind === "refresh") {
			return {
				svg: composeTile({ glyph: input.refreshing ? "loader" : "refresh-cw", accent: NAV_ACCENT, dim: stale && !input.refreshing, status: input.refreshing ? "idle" : tileStatus }),
				title: input.refreshing ? "…" : formatAgeLong(ageMs),
				blocked: false,
			};
		}
		const pages = infoPages(at.module);
		const page = pages[(input.infoPage ?? 0) % pages.length]!;
		const name = cleanLabel(at.module.name);
		const percent = at.module.batteryPercent;
		if (page === "battery" && typeof percent === "number") {
			return {
				svg: composeTile({ glyph: batteryGlyph(percent), accent: batteryAccent(percent), status: okStatus }),
				title: joinLines([`${Math.round(percent)} %`, name]),
				blocked: false,
			};
		}
		return {
			svg: composeTile({ glyph: "clock", accent: NAV_ACCENT, dim: stale, status: tileStatus }),
			title: joinLines([formatAgeLong(ageMs), name]),
			blocked: false,
		};
	}

	const preview = navigationPreview(input.kind, snapshot, input.focus);
	const dir = DIRECTION[input.kind];
	if (!preview || dir === undefined) return dimmed(glyph, "No data");
	const arrow = ARROW[dir];
	const target = locate(snapshot, preview.focus);
	if (input.kind === "next-metric" || input.kind === "prev-metric") {
		const id = displayMetricOf(preview.focus.metric);
		const def = id ? METRICS[id] : undefined;
		if (preview.blocked || !def) return dimmed(def?.glyph ?? glyph, "Only one\nvalue");
		return { svg: composeTile({ glyph: def.glyph, accent: NAV_ACCENT, status: okStatus }), title: `${arrow} ${def.label}`, blocked: false };
	}
	if (input.kind === "next-sensor" || input.kind === "prev-sensor") {
		if (preview.blocked || !target) return dimmed(glyph, "No other\nsensor");
		return {
			svg: composeTile({ glyph: ROLE_GLYPH[target.module.role], accent: NAV_ACCENT, status: okStatus }),
			title: `${arrow} ${cleanLabel(target.module.name) || "(unnamed)"}`,
			blocked: false,
		};
	}
	if (preview.blocked || !target) return dimmed(glyph, "One\nstation");
	return {
		svg: composeTile({ glyph, accent: NAV_ACCENT, status: okStatus }),
		title: `${arrow} ${cleanLabel(target.station.name) || "(unnamed)"}`,
		blocked: false,
	};
}

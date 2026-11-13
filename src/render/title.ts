/**
 * Native key title text. Pure.
 *
 * The value goes through Stream Deck's own title rather than the image: it is crisp, it
 * follows the user's font settings, and it needs no font handling on our side. Status
 * words follow the display table in docs/ARCHITECTURE.md.
 *
 * Known limit: the SDK says a plugin can only set the title while the user has not typed
 * a custom title of their own in the Stream Deck app (typings of `Key.setTitle`). The
 * plugin cannot detect that, so with a custom title neither the value nor these status
 * words are visible. What still shows: the glyph and its colour (every status has its own
 * glyph, see key-view.ts) and, with `bigText`, the value drawn into the image.
 */

import type { Classification } from "./status.ts";

/**
 * Longest LINE of a status text on a key: a key title is about 8 to 10 characters wide, and
 * longer text is cut or wrapped mid-word by Stream Deck. A status that needs more says it on
 * two lines (explicit "\n"); tests/render-status-faces.test.ts checks every status text
 * (this table, the history table and the navigation keys) against this limit.
 */
export const MAX_STATUS_LINE_CHARS = 10;

/** Words shown instead of a value; one per status in the display table. Every line is at most MAX_STATUS_LINE_CHARS long. */
export const STATUS_WORDS = {
	"unreachable": "No signal",
	"auth-error": "Sign in",
	"no-credentials": "Set up",
	"loading": "…",
	"offline": "Offline",
	"no-module": "Pick\nmodule",
	"no-data": "No data",
	"no-service": "Offline",
} as const;

export type StatusWordKind = keyof typeof STATUS_WORDS;

export function statusWord(kind: Exclude<Classification["kind"], "value">): string {
	return STATUS_WORDS[kind];
}

/**
 * Longest label on a key; a key title is about 8 to 10 characters wide. The Property
 * Inspector's label field must use the same number as its `maxlength` (the key cuts
 * longer text with an ellipsis, so a longer field would promise what the key cannot show);
 * tests/render-label-limit.test.ts compares the two.
 */
export const MAX_LABEL_CHARS = 9;

/** Longest label on the dial's touch strip, which is wider than a key. */
export const MAX_DIAL_LABEL_CHARS = 20;

/**
 * Make an untrusted name safe for a title: control characters and bidi/zero-width
 * controls become spaces, runs collapse, and the result is cut with an ellipsis.
 */
export function cleanLabel(text: string | undefined, max = MAX_LABEL_CHARS): string {
	if (typeof text !== "string") return "";
	const spaced = text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, " ");
	const collapsed = spaced.replace(/\s+/g, " ").trim();
	const chars = Array.from(collapsed);
	return chars.length <= max ? collapsed : `${chars.slice(0, max - 1).join("")}…`;
}

/** Join non-empty lines with newlines; returns undefined for no lines (the title then falls back to the one in the manifest). */
export function joinLines(lines: ReadonlyArray<string | undefined>): string | undefined {
	const kept = lines.filter((line): line is string => typeof line === "string" && line.length > 0);
	return kept.length === 0 ? undefined : kept.join("\n");
}

/** "↓-3 ↑12" for the min/max line of a title; integers keep it narrow. */
export function minMaxLine(min: number, max: number): string {
	return `↓${Math.round(min)} ↑${Math.round(max)}`;
}

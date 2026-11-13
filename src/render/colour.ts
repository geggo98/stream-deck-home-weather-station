/**
 * Colours for the key tiles.
 *
 * Every threshold below is a UX choice made so that a glance tells "comfortable or
 * not". They are NOT medical, building-code or safety advice: the CO2 bands in
 * particular are loosely inspired by common indoor-air-quality rules of thumb and
 * must not be used to decide whether a room is safe.
 *
 * All functions take the value in the API's metric unit and return `#rrggbb`. They are
 * band-based or quantised on purpose: a colour that changes with every 0.1 would make
 * the composed image differ on every poll and defeat the de-duplication of image writes.
 */

import type { DisplayMetricId } from "./metrics.ts";

/** Colour used when there is no value to colour. */
export const NEUTRAL_COLOUR = "#9AA3AD";
export const WARNING_COLOUR = "#E5A23B";
export const ERROR_COLOUR = "#E5534B";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** True for exactly `#rrggbb`. Everything that enters SVG markup as a colour passes this. */
export function isHexColour(value: unknown): value is string {
	return typeof value === "string" && HEX.test(value);
}

/** Return `value` if it is a valid colour, else the neutral colour. */
export function safeColour(value: unknown): string {
	return isHexColour(value) ? value : NEUTRAL_COLOUR;
}

function toRgb(hex: string): [number, number, number] {
	const h = safeColour(hex);
	return [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];
}

function toHex(rgb: readonly number[]): string {
	return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear mix: t = 0 gives `a`, t = 1 gives `b`. */
export function mixColour(a: string, b: string, t: number): string {
	const ca = toRgb(a);
	const cb = toRgb(b);
	const k = Math.max(0, Math.min(1, t));
	return toHex(ca.map((c, i) => c + (cb[i]! - c) * k));
}

/** Scale toward black; `factor` 1 keeps the colour. */
export function scaleColour(hex: string, factor: number): string {
	return toHex(toRgb(hex).map((c) => c * factor));
}

/** Temperature stops in degrees Celsius; values between stops are interpolated. */
export const TEMPERATURE_STOPS: ReadonlyArray<readonly [number, string]> = [
	[-15, "#6F8CFF"],
	[0, "#4FB3F6"],
	[10, "#4FD1B5"],
	[18, "#7BDC7B"],
	[24, "#F2D14B"],
	[30, "#F5993D"],
	[38, "#EF5A4C"],
];

/** Temperature colour; rounds to whole degrees first so 0.1 jitter never changes the picture. */
export function temperatureColour(celsius: number): string {
	if (!Number.isFinite(celsius)) return NEUTRAL_COLOUR;
	const c = Math.round(celsius);
	const first = TEMPERATURE_STOPS[0]!;
	const last = TEMPERATURE_STOPS[TEMPERATURE_STOPS.length - 1]!;
	if (c <= first[0]) return first[1];
	if (c >= last[0]) return last[1];
	for (let i = 1; i < TEMPERATURE_STOPS.length; i++) {
		const [hi, hiColour] = TEMPERATURE_STOPS[i]!;
		const [lo, loColour] = TEMPERATURE_STOPS[i - 1]!;
		if (c <= hi) return mixColour(loColour, hiColour, (c - lo) / (hi - lo));
	}
	return last[1];
}

const GOOD = "#58C97A";
const FAIR = "#D4D75A";
const POOR = "#F0A43C";
const BAD = "#EF5A4C";
const COOL = "#4FB3F6";

/** Upper bounds (inclusive) of the CO2 bands in ppm: good, fair, poor; above is bad. */
export const CO2_BANDS = [800, 1200, 1600] as const;
export function co2Colour(ppm: number): string {
	if (!Number.isFinite(ppm)) return NEUTRAL_COLOUR;
	if (ppm <= CO2_BANDS[0]) return GOOD;
	if (ppm <= CO2_BANDS[1]) return FAIR;
	if (ppm <= CO2_BANDS[2]) return POOR;
	return BAD;
}

/** Humidity in percent: dry below the first bound, comfortable up to the second, humid above. */
export const HUMIDITY_BANDS = [30, 60, 70] as const;
export function humidityColour(percent: number): string {
	if (!Number.isFinite(percent)) return NEUTRAL_COLOUR;
	if (percent < HUMIDITY_BANDS[0]) return POOR;
	if (percent <= HUMIDITY_BANDS[1]) return GOOD;
	if (percent <= HUMIDITY_BANDS[2]) return FAIR;
	return COOL;
}

/** Noise in dB: quiet, normal, loud; above the last bound is very loud. */
export const NOISE_BANDS = [45, 65, 80] as const;
export function noiseColour(db: number): string {
	if (!Number.isFinite(db)) return NEUTRAL_COLOUR;
	if (db <= NOISE_BANDS[0]) return GOOD;
	if (db <= NOISE_BANDS[1]) return FAIR;
	if (db <= NOISE_BANDS[2]) return POOR;
	return BAD;
}

/**
 * Bands for the "Pressure" field in hPa: low below the first bound, high from the second.
 * The bounds are everyday weather-map values. Whether that field is the sea-level or the
 * station-level pressure is UNVERIFIED (docs/WEATHER-API.md), and for a station well above
 * sea level the colours would be off if it is the latter. "Pressure (alt.)"
 * (absolutePressure) deliberately does not use these bands.
 */
export const PRESSURE_BANDS = [1000, 1020] as const;
/** Fixed accent of the "Pressure (alt.)" metric: no value-dependent bands, see PRESSURE_BANDS. */
export const ALT_PRESSURE_COLOUR = "#6FA8DC";

export function pressureColour(hpa: number): string {
	if (!Number.isFinite(hpa)) return NEUTRAL_COLOUR;
	if (hpa < PRESSURE_BANDS[0]) return "#8E7CF0";
	if (hpa < PRESSURE_BANDS[1]) return "#6FA8DC";
	return "#F2B84B";
}

/** Rain in mm (any accumulation window): none, light, heavy. Shared bounds on purpose: simple. */
export const RAIN_BANDS = [0.1, 5] as const;
export function rainColour(mm: number): string {
	if (!Number.isFinite(mm)) return NEUTRAL_COLOUR;
	if (mm < RAIN_BANDS[0]) return "#7C8A99";
	if (mm <= RAIN_BANDS[1]) return "#4FB3F6";
	return "#3C7BE0";
}

/** Wind in km/h: calm, breezy, strong; above the last bound is storm-force. */
export const WIND_BANDS = [20, 40, 62] as const;
export function windColour(kmh: number): string {
	if (!Number.isFinite(kmh)) return NEUTRAL_COLOUR;
	if (kmh < WIND_BANDS[0]) return GOOD;
	if (kmh < WIND_BANDS[1]) return FAIR;
	if (kmh < WIND_BANDS[2]) return POOR;
	return BAD;
}

/** Accent colour for a metric's value (API metric unit). */
export function accentFor(metric: DisplayMetricId, value: number): string {
	switch (metric) {
		case "temperature":
			return temperatureColour(value);
		case "humidity":
			return humidityColour(value);
		case "co2":
			return co2Colour(value);
		case "noise":
			return noiseColour(value);
		case "pressure":
			return pressureColour(value);
		case "absolutePressure":
			return Number.isFinite(value) ? ALT_PRESSURE_COLOUR : NEUTRAL_COLOUR;
		case "rain":
		case "rain1h":
		case "rain24h":
			return rainColour(value);
		case "wind":
		case "gust":
			return windColour(value);
	}
}

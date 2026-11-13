/**
 * Validation of a getstationsdata response into the normalised StationSnapshot.
 *
 * Strict about types, tolerant of absence: every field may be missing (an unreachable module
 * has no `dashboard_data`), nothing is invented, and a value that is not a finite number
 * inside a plausible range is dropped rather than shown. Personal data in the response
 * (`user.mail`, `place`, `home_id`) is never copied.
 *
 * Decision: Pressure vs AbsolutePressure. The OpenAPI document describes `Pressure` as
 * "surface pressure" and `AbsolutePressure` as "sea-level pressure"; both research reports
 * flag these descriptions as probably swapped, and that is UNVERIFIED. We therefore map the
 * KEYS one-to-one (`Pressure` -> `pressure`, `AbsolutePressure` -> `absolutePressure`) and
 * make no claim in code about which is which. Home Assistant also exposes `Pressure` only.
 * The UI labels `pressure` as the primary pressure; `scripts/probe-api.ts` reports from a
 * real response which of the two is the larger one, which settles the question for an
 * elevated station. If the live answer contradicts the label, swap the two keys HERE.
 */

import { truncateForLog } from "../logging.ts";
import { NetatmoError } from "./errors.ts";
import type {
	MetricKey,
	MetricValues,
	ModuleData,
	ModuleRole,
	ModuleType,
	StationData,
	StationSnapshot,
	UnitPreferences,
} from "./types.ts";

export const MAX_STATIONS = 10;
export const MAX_MODULES_PER_STATION = 20;
const MAX_NAME_LENGTH = 64;
const MAX_ID_LENGTH = 64;

export const MODULE_ROLES: Readonly<Record<ModuleType, ModuleRole>> = {
	NAMain: "base",
	NAModule1: "outdoor",
	NAModule2: "wind",
	NAModule3: "rain",
	NAModule4: "indoor-extra",
};

const DEFAULT_NAMES: Readonly<Record<ModuleRole, string>> = {
	base: "Indoor",
	outdoor: "Outdoor",
	wind: "Wind",
	rain: "Rain",
	"indoor-extra": "Indoor module",
};

interface MetricSpec {
	readonly key: MetricKey;
	/** Compass angle: 360 is the same direction as 0 and is normalised to 0. Only angles; 360 is a valid CO2, pressure or rain reading. */
	readonly angle?: true;
	/** Plausible range in native units; outside = dropped. Generous: this is a sanity net, not a QA rule. */
	readonly min: number;
	readonly max: number;
}

/** dashboard_data key -> metric. Units as documented: °C, %, ppm, dB, mbar, mm, km/h, degrees. */
const NUMERIC_METRICS: Readonly<Record<string, MetricSpec>> = {
	Temperature: { key: "temperature", min: -90, max: 70 },
	min_temp: { key: "tempMin", min: -90, max: 70 },
	max_temp: { key: "tempMax", min: -90, max: 70 },
	Humidity: { key: "humidity", min: 0, max: 100 },
	CO2: { key: "co2", min: 0, max: 100_000 },
	Noise: { key: "noise", min: 0, max: 200 },
	Pressure: { key: "pressure", min: 300, max: 1200 },
	AbsolutePressure: { key: "absolutePressure", min: 300, max: 1200 },
	Rain: { key: "rain", min: 0, max: 10_000 },
	sum_rain_1: { key: "rain1h", min: 0, max: 10_000 },
	sum_rain_24: { key: "rain24h", min: 0, max: 10_000 },
	WindStrength: { key: "windStrength", min: 0, max: 500 },
	GustStrength: { key: "gustStrength", min: 0, max: 500 },
	WindAngle: { key: "windAngle", min: 0, max: 360, angle: true },
	GustAngle: { key: "gustAngle", min: 0, max: 360, angle: true },
};

const TREND_METRICS: Readonly<Record<string, MetricKey>> = {
	temp_trend: "tempTrend",
	pressure_trend: "pressureTrend",
};

const TREND_VALUES: Readonly<Record<string, number>> = { up: 1, stable: 0, down: -1 };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Printable, trimmed, length-capped text; control characters (including ANSI escapes) removed. */
export function cleanText(value: unknown, maxLength = MAX_NAME_LENGTH): string | undefined {
	if (typeof value !== "string") return undefined;
	// eslint-disable-next-line no-control-regex
	const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
	if (stripped.length === 0) return undefined;
	return [...stripped].slice(0, maxLength).join("");
}

/**
 * Ids come with stray spaces in some responses (pyatmo `fix_id` strips them). A `|` is refused:
 * the plugin joins station and module id with it ("<station>|<module>", the module key of the
 * settings and the history cache key), so an id containing it could not be told apart.
 */
function cleanId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// eslint-disable-next-line no-control-regex
	const id = value.replace(/[\s\u0000-\u001f\u007f]/g, "");
	return id.length > 0 && id.length <= MAX_ID_LENGTH && !id.includes("|") ? id : undefined;
}

export function parseMetrics(dashboard: unknown, warn?: (message: string) => void): MetricValues {
	const values: Record<string, number> = {};
	if (!isObject(dashboard)) return values;
	for (const [wireKey, spec] of Object.entries(NUMERIC_METRICS)) {
		const raw = dashboard[wireKey];
		if (raw === undefined) continue;
		if (!finite(raw) || raw < spec.min || raw > spec.max) {
			warn?.(`dropped implausible or non-numeric ${wireKey}`);
			continue;
		}
		values[spec.key] = spec.angle && raw === 360 ? 0 : raw;
	}
	for (const [wireKey, key] of Object.entries(TREND_METRICS)) {
		const raw = dashboard[wireKey];
		if (typeof raw === "string" && Object.hasOwn(TREND_VALUES, raw)) values[key] = TREND_VALUES[raw] as number;
		else if (raw !== undefined) warn?.(`dropped unknown ${wireKey} value`);
	}
	return values;
}

export function parseModule(
	raw: unknown,
	isBase: boolean,
	warn?: (message: string) => void,
): ModuleData | undefined {
	if (!isObject(raw)) return undefined;
	const id = cleanId(raw._id);
	const type = raw.type;
	if (!id || typeof type !== "string" || !Object.hasOwn(MODULE_ROLES, type)) {
		if (typeof type === "string") warn?.(`skipped module of unsupported type ${truncateForLog(type, 20)}`);
		return undefined;
	}
	const moduleType = type as ModuleType;
	if (isBase && moduleType !== "NAMain") return undefined;
	const role = MODULE_ROLES[moduleType];
	const dashboard = raw.dashboard_data;
	const timeUtc = isObject(dashboard) ? dashboard.time_utc : undefined;
	const measuredAt = finite(timeUtc) && timeUtc > 0 ? Math.round(timeUtc * 1000) : null;
	const battery = raw.battery_percent;
	return {
		id,
		type: moduleType,
		role,
		name: cleanText(raw.module_name) ?? DEFAULT_NAMES[role],
		// absent `reachable` counts as reachable (Home Assistant does the same); freshness comes from measuredAt
		reachable: typeof raw.reachable === "boolean" ? raw.reachable : true,
		measuredAt,
		...(finite(battery) && battery >= 0 && battery <= 100 ? { batteryPercent: battery } : {}),
		values: parseMetrics(dashboard, warn),
	};
}

export function parseStation(raw: unknown, warn?: (message: string) => void): StationData | undefined {
	if (!isObject(raw)) return undefined;
	const base = parseModule(raw, true, warn);
	if (!base) return undefined;
	const modules: ModuleData[] = [base];
	const seen = new Set<string>([base.id]);
	const nested = Array.isArray(raw.modules) ? raw.modules : [];
	for (const entry of nested.slice(0, MAX_MODULES_PER_STATION)) {
		const parsed = parseModule(entry, false, warn);
		if (parsed && !seen.has(parsed.id)) {
			seen.add(parsed.id);
			modules.push(parsed);
		}
	}
	if (nested.length > MAX_MODULES_PER_STATION) warn?.(`ignored ${nested.length - MAX_MODULES_PER_STATION} modules above the limit`);
	// `station_name` is marked "DO NOT USE ANYMORE" in the spec; prefer home_name, fall back for older accounts
	const name = cleanText(raw.home_name) ?? cleanText(raw.station_name) ?? cleanText(raw.module_name) ?? "Station";
	return { id: base.id, name, modules };
}

const WIND_UNITS = ["kmh", "mph", "ms", "beaufort", "knots"] as const;
const PRESSURE_UNITS = ["mbar", "inhg", "mmhg"] as const;

function enumIndex<T>(list: readonly T[], value: unknown): T | undefined {
	return Number.isInteger(value) ? list[value as number] : undefined;
}

function cleanLocale(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,2}$/.test(value)) return undefined;
	try {
		return Intl.getCanonicalLocales(value.replace(/_/g, "-"))[0];
	} catch {
		return undefined;
	}
}

/**
 * body.user.administrative: unit 0|1, windunit 0..4 (kph, mph, m/s, beaufort, knot),
 * pressureunit 0..2 (mbar, inHg, mmHg), lang, reg_locale (docs: weather page and OpenAPI spec).
 * Missing or unknown values fall back to metric (Home Assistant clamps UNKNOWN the same way),
 * except that an imperial account without explicit wind/pressure unit gets mph/inHg.
 */
export function parsePreferences(user: unknown): UnitPreferences {
	const admin = isObject(user) && isObject(user.administrative) ? user.administrative : {};
	const unitSystem = admin.unit === 1 ? "imperial" : "metric";
	const windUnit = enumIndex(WIND_UNITS, admin.windunit) ?? (unitSystem === "imperial" ? "mph" : "kmh");
	const pressureUnit = enumIndex(PRESSURE_UNITS, admin.pressureunit) ?? (unitSystem === "imperial" ? "inhg" : "mbar");
	// reg_locale = "regional preferences" (number/date format); lang = UI language. Number format follows the former.
	const locale = cleanLocale(admin.reg_locale) ?? cleanLocale(admin.lang);
	return { unitSystem, windUnit, pressureUnit, ...(locale ? { locale } : {}) };
}

/**
 * @param json - The parsed response envelope.
 * @param fetchedAt - Our clock when the response arrived (epoch ms).
 * @throws NetatmoError("protocol") when the envelope has no usable `body`.
 */
export function parseStationsResponse(
	json: unknown,
	fetchedAt: number,
	options: { readonly warn?: (message: string) => void } = {},
): StationSnapshot {
	if (!isObject(json) || !isObject(json.body)) {
		throw new NetatmoError("protocol", "The response has no body object");
	}
	const body = json.body;
	const hasDevicesArray = Array.isArray(body.devices);
	const devices: unknown[] = Array.isArray(body.devices) ? body.devices : [];
	if (!hasDevicesArray) options.warn?.("the response body has no `devices` array");
	const stations: StationData[] = [];
	const seen = new Set<string>();
	for (const device of devices.slice(0, MAX_STATIONS)) {
		const station = parseStation(device, options.warn);
		if (station && !seen.has(station.id)) {
			seen.add(station.id);
			stations.push(station);
		}
	}
	if (devices.length > MAX_STATIONS) options.warn?.(`ignored ${devices.length - MAX_STATIONS} stations above the limit`);
	// "ok, 0 stations" is only believable for a genuinely empty account (`devices: []`). A renamed
	// or missing array, or devices of which none could be understood, would otherwise look like
	// "no stations" forever.
	if (stations.length === 0 && (devices.length > 0 || (!hasDevicesArray && Object.keys(body).length > 0))) {
		throw new NetatmoError(
			"protocol",
			hasDevicesArray ? "None of the stations in the response could be understood" : "The response has no list of stations",
		);
	}
	return { fetchedAt, stations, preferences: parsePreferences(body.user) };
}

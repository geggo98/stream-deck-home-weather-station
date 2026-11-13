/**
 * Turn a RAW getstationsdata response (saved by `npm run probe -- --raw-out <file>`) into an
 * ANONYMISED test fixture under tests/fixtures/station/.
 *
 *   npm run capture:fixture -- <raw.json> --name <fixture-name> [--out-dir <dir>] [--force]
 *
 * Approach: WHITELIST, not blacklist. The output is rebuilt from the few fields the parser
 * reads; everything else (location, timezone, city, country, user e-mail, home ids, firmware
 * strings, any field Netatmo adds tomorrow) is dropped by construction. Identifiers are
 * replaced by documentation-range MAC addresses 00:00:5e:00:53:xx, names by generic ones,
 * timestamps are shifted so the newest measurement is a fixed constant.
 *
 * Then it VERIFIES: every string of the input (and every coordinate number) that could
 * identify something is searched in the output, and the output is scanned for formats
 * (MACs outside the documentation range, e-mail addresses, UUID-like and 24-hex ids, IPv4
 * addresses). Any hit aborts without writing a file. Short originals (< 6 characters) are
 * compared against whole string values only, longer ones as case-insensitive substrings; a
 * short name such as "Bob" cannot be searched as a substring without drowning in false hits.
 * A failing verification prints counts, never the offending values.
 *
 * The raw input contains personal data: delete it after capturing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const BASE_TIME_SECONDS = 1_700_000_000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

const MODULE_TYPES = ["NAMain", "NAModule1", "NAModule2", "NAModule3", "NAModule4"] as const;
const DATA_TYPES = new Set(["Temperature", "CO2", "Humidity", "Noise", "Pressure", "Rain", "Wind"]);
const GENERIC_NAMES: Readonly<Record<string, string>> = {
	NAMain: "Indoor",
	NAModule1: "Outdoor",
	NAModule2: "Wind",
	NAModule3: "Rain",
	NAModule4: "Indoor extra",
};
const TRENDS = new Set(["up", "down", "stable"]);

const NUMERIC_DASHBOARD_KEYS = [
	"Temperature", "Humidity", "CO2", "Noise", "Pressure", "AbsolutePressure", "min_temp", "max_temp",
	"Rain", "sum_rain_1", "sum_rain_24", "WindStrength", "WindAngle", "GustStrength", "GustAngle",
	"max_wind_str", "max_wind_angle",
];
const TIME_DASHBOARD_KEYS = ["time_utc", "date_min_temp", "date_max_temp", "date_max_wind_str"];
const TREND_DASHBOARD_KEYS = ["temp_trend", "pressure_trend"];
const NUMERIC_STATUS_KEYS = ["firmware", "wifi_status", "rf_status", "battery_vp", "battery_percent"];
const TIME_STATUS_KEYS = ["last_message", "last_seen", "last_status_store", "last_setup", "last_upgrade", "date_setup"];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface AnonymiseResult {
	readonly output: unknown;
	/** Everything in the input that must not survive; used by `verifyNoLeak`. */
	readonly originalStrings: readonly string[];
	readonly originalNumbers: readonly number[];
	readonly generatedStrings: ReadonlySet<string>;
	readonly stations: number;
	readonly modules: number;
}

function collectStrings(value: unknown, into: Set<string>): void {
	if (typeof value === "string") into.add(value);
	else if (Array.isArray(value)) for (const v of value) collectStrings(v, into);
	else if (isObject(value)) for (const v of Object.values(value)) collectStrings(v, into);
}

/** Coordinates: numbers that locate the home. (Altitude is not searched: a bare integer collides with firmware numbers and is dropped anyway.) */
function collectLocationNumbers(raw: unknown): number[] {
	const out: number[] = [];
	const visit = (v: unknown): void => {
		if (Array.isArray(v)) v.forEach(visit);
		else if (isObject(v)) {
			if (isObject(v.place)) {
				const p = v.place;
				if (Array.isArray(p.location)) out.push(...p.location.filter(isNum));
			}
			Object.values(v).forEach(visit);
		}
	};
	visit(raw);
	return out;
}

function newestTimeUtc(raw: unknown): number {
	let newest = 0;
	const visit = (v: unknown): void => {
		if (Array.isArray(v)) v.forEach(visit);
		else if (isObject(v)) {
			if (isObject(v.dashboard_data) && isNum(v.dashboard_data.time_utc)) newest = Math.max(newest, v.dashboard_data.time_utc);
			Object.values(v).forEach(visit);
		}
	};
	visit(raw);
	return newest;
}

export function anonymise(raw: unknown): AnonymiseResult {
	if (!isObject(raw) || !isObject(raw.body)) throw new Error("input is not a getstationsdata response (no body object)");
	const body = raw.body;
	const devices = Array.isArray(body.devices) ? body.devices.slice(0, 10) : [];
	const originals = new Set<string>();
	collectStrings(raw, originals);
	const generated = new Set<string>(["ok", "en-GB", ...MODULE_TYPES, ...TRENDS, ...DATA_TYPES, ...Object.values(GENERIC_NAMES)]);

	const newest = newestTimeUtc(raw);
	const shift = newest > 0 ? BASE_TIME_SECONDS - newest : 0;
	const shiftTime = (t: number): number => Math.round(t + shift);

	const macs = new Map<string, string>();
	const fakeMac = (original: unknown): string | undefined => {
		if (typeof original !== "string") return undefined;
		const key = original.replace(/\s/g, "").toLowerCase();
		if (!key) return undefined;
		let mac = macs.get(key);
		if (!mac) {
			mac = `00:00:5e:00:53:${(macs.size + 1).toString(16).padStart(2, "0")}`;
			macs.set(key, mac);
			generated.add(mac);
		}
		return mac;
	};

	const copyNumbers = (src: Json, keys: readonly string[], out: Json): void => {
		for (const k of keys) if (isNum(src[k])) out[k] = src[k];
	};
	const copyTimes = (src: Json, keys: readonly string[], out: Json): void => {
		for (const k of keys) if (isNum(src[k])) out[k] = shiftTime(src[k] as number);
	};

	const dashboard = (src: unknown): Json | undefined => {
		if (!isObject(src)) return undefined;
		const out: Json = {};
		copyTimes(src, TIME_DASHBOARD_KEYS, out);
		copyNumbers(src, NUMERIC_DASHBOARD_KEYS, out);
		for (const k of TREND_DASHBOARD_KEYS) if (typeof src[k] === "string" && TRENDS.has(src[k] as string)) out[k] = src[k];
		return out;
	};

	const moduleOut = (src: Json, baseMac: string | undefined, isBase: boolean): Json | undefined => {
		const type = (MODULE_TYPES as readonly unknown[]).includes(src.type) ? (src.type as string) : undefined;
		const id = fakeMac(src._id);
		if (!type || !id) return undefined;
		const out: Json = { _id: id, type, module_name: GENERIC_NAMES[type] };
		if (!isBase && baseMac) out.bridge = baseMac;
		copyNumbers(src, NUMERIC_STATUS_KEYS, out);
		copyTimes(src, TIME_STATUS_KEYS, out);
		if (typeof src.reachable === "boolean") out.reachable = src.reachable;
		if (typeof src.co2_calibrating === "boolean") out.co2_calibrating = src.co2_calibrating;
		if (Array.isArray(src.data_type)) out.data_type = src.data_type.filter((d) => typeof d === "string" && DATA_TYPES.has(d));
		const dash = dashboard(src.dashboard_data);
		if (dash) out.dashboard_data = dash;
		return out;
	};

	let moduleCount = 0;
	const outDevices: Json[] = [];
	for (const device of devices) {
		if (!isObject(device)) continue;
		const base = moduleOut(device, undefined, true);
		if (!base) continue;
		const index = outDevices.length + 1;
		const home = `Test Home ${index}`;
		generated.add(home);
		base.home_name = home;
		const nested = Array.isArray(device.modules) ? device.modules.slice(0, 20) : [];
		const modules = nested
			.map((m) => (isObject(m) ? moduleOut(m, base._id as string, false) : undefined))
			.filter((m): m is Json => m !== undefined);
		moduleCount += 1 + modules.length;
		outDevices.push({ ...base, modules });
	}

	const adminSrc = isObject(body.user) && isObject(body.user.administrative) ? body.user.administrative : {};
	const administrative: Json = {};
	copyNumbers(adminSrc, ["unit", "windunit", "pressureunit", "feel_like_algo"], administrative);
	// language/region would reveal the owner's country; the parser needs only a valid value
	administrative.lang = "en-GB";
	administrative.reg_locale = "en-GB";

	const output = {
		status: "ok",
		time_exec: 0.05,
		time_server: BASE_TIME_SECONDS + 60,
		body: { devices: outDevices, user: { administrative } },
	};
	return {
		output,
		originalStrings: [...originals],
		originalNumbers: collectLocationNumbers(raw),
		generatedStrings: generated,
		stations: outDevices.length,
		modules: moduleCount,
	};
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @returns Human-readable problems WITHOUT the offending values; empty = clean.
 */
export function verifyNoLeak(result: AnonymiseResult): string[] {
	const problems: string[] = [];
	const text = JSON.stringify(result.output);
	const lower = text.toLowerCase();
	const outputStrings = new Set<string>();
	collectStrings(result.output, outputStrings);
	const generatedLower = new Set([...result.generatedStrings].map((s) => s.toLowerCase()));
	const outputLower = new Set([...outputStrings].map((s) => s.toLowerCase()));

	let checked = 0;
	for (const original of result.originalStrings) {
		const o = original.trim();
		if (o.length < 3 || generatedLower.has(o.toLowerCase())) continue;
		checked++;
		const needle = o.toLowerCase();
		const hit = o.length >= 6 ? lower.includes(needle) || lower.includes(needle.replace(/[:\-\s]/g, "")) : outputLower.has(needle);
		if (hit) problems.push(`an original string of length ${o.length} survives in the output`);
	}
	for (const n of result.originalNumbers) {
		const token = String(n);
		if (token.replace(/[-.]/g, "").length < 3) continue; // "0", "5": meaningless as a search term
		if (new RegExp(`(?<![\\d.])${escapeRe(token)}(?![\\d])`).test(text)) problems.push("a location number survives in the output");
	}
	for (const mac of text.match(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi) ?? []) {
		if (!mac.toLowerCase().startsWith("00:00:5e:00:53:")) problems.push("a MAC address outside the documentation range is present");
	}
	if (/@/.test(text)) problems.push("an @ (e-mail address?) is present");
	if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) problems.push("a UUID-like id is present");
	if (/\b[0-9a-f]{24}\b/i.test(text)) problems.push("a 24-hex id is present");
	if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text)) problems.push("an IPv4-like value is present");
	if (checked === 0 && result.originalStrings.length > 0) problems.push("nothing was checked: every original string equalled a generic value (is the input real?)");
	return problems;
}

function isMain(): boolean {
	return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

function main(argv: string[]): number {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			name: { type: "string", default: "captured" },
			"out-dir": { type: "string", default: "tests/fixtures/station" },
			force: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help || positionals.length !== 1) {
		console.error("usage: npm run capture:fixture -- <raw.json> --name <fixture-name> [--out-dir <dir>] [--force]");
		return values.help ? 0 : 1;
	}
	const input = positionals[0] as string;
	if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(values.name as string)) {
		console.error("--name must be lowercase letters, digits and dashes");
		return 1;
	}
	const stat = fs.statSync(input);
	if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
		console.error(`input must be a regular file of at most ${MAX_INPUT_BYTES} bytes`);
		return 1;
	}
	let result: AnonymiseResult;
	try {
		result = anonymise(JSON.parse(fs.readFileSync(input, "utf8")));
	} catch (error) {
		console.error(`cannot anonymise: ${(error as Error).message}`);
		return 1;
	}
	const problems = verifyNoLeak(result);
	if (problems.length > 0) {
		console.error(`VERIFICATION FAILED, nothing written (${problems.length} problem(s)):`);
		for (const p of new Set(problems)) console.error(`  - ${p}`);
		return 1;
	}
	const target = path.join(values["out-dir"] as string, `${values.name}.json`);
	if (fs.existsSync(target) && !values.force) {
		console.error(`${target} exists; use --force to overwrite`);
		return 1;
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp.${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(result.output, null, "\t")}\n`, { mode: 0o644 });
	fs.renameSync(tmp, target);
	console.error(`wrote ${target}: ${result.stations} station(s), ${result.modules} module(s); ${result.originalStrings.length} original strings checked, none survive`);
	console.error("Delete the raw input file now: it contains personal data.");
	return 0;
}

if (isMain()) process.exit(main(process.argv.slice(2)));

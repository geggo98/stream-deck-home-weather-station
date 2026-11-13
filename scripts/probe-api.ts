/**
 * Probe the real service with YOUR credentials and print a STRUCTURAL summary.
 *
 *   secretspec run -- npm run probe [-- --raw-out <file>] [--no-post-check] [--history]
 *
 * Reads NETATMO_CLIENT_ID, NETATMO_CLIENT_SECRET, NETATMO_REFRESH_TOKEN (see secretspec.toml).
 *
 * IMPORTANT, because Netatmo rotates the refresh token: the refresh at the start of this
 * script invalidates the value in your secret store. The new token is therefore persisted
 * by the token manager BEFORE anything else happens (same code path as the plugin):
 *   1. `secretspec set NETATMO_REFRESH_TOKEN --from-file -` with the token on STDIN
 *      (never on the command line, never printed; `--from-file -` needs secretspec 0.21+);
 *   2. if that fails: a 0600 file in a private temp directory; only its PATH is printed.
 *   3. if that fails too: the run exits non-zero with a message that the old token is invalid.
 * Do not run this probe against the refresh token the installed plugin uses: both would
 * invalidate each other. Generate a separate token pair for probing.
 *
 * Output never contains ids, names, coordinates or measured values, only structure: module
 * types and roles, which metric keys are present, data ages, reachable flags, unit
 * preferences. `--raw-out` saves the raw response (0600): it DOES contain personal data;
 * feed it to `npm run capture:fixture` and delete it. A target inside the repository working
 * tree is refused unless git ignores it, and an existing file is never overwritten.
 *
 * It also checks two open questions of docs/WEATHER-API.md: whether GET and POST on
 * getstationsdata are equivalent, and whether `Pressure` is the larger of the two pressure
 * keys (which is what sea-level reduction gives for a station above sea level).
 *
 * `--history` additionally requests 24 h of temperature (scale 30min) for the first base
 * module, once with optimize=true and once with optimize=false, and prints structural facts
 * only: which response shape came back, number of chunks and points, step, how many null
 * holes, and a value RANGE CLASS (never a value). That settles the open getmeasure questions
 * of docs/WEATHER-API.md (shape, step_time, unit, holes) and prints the first/last timestamp
 * relative to the request (bucket start vs middle, local vs UTC; see HistoryPoint.t).
 *
 * Exit codes: 0 ok, 1 error (also: the rotated token could not be stored anywhere), 2 authentication error.
 * NOT run against the live service by the author of this script (no credentials available).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CredentialStore, StoredCredentials } from "../src/adapter/station/credentials.ts";
import { NetatmoClient } from "../src/adapter/station/client.ts";
import { isNetatmoError } from "../src/adapter/station/errors.ts";
import { buildMeasureQuery, measureBodyOf, parseMeasureBody, scaleFor, scaleMs } from "../src/adapter/station/history-parse.ts";
import { parseStationsResponse } from "../src/adapter/station/parse.ts";
import { redactSecrets } from "../src/adapter/station/redact.ts";
import { TokenManager } from "../src/adapter/station/token-manager.ts";
import type { HistoryRequest } from "../src/adapter/station/types.ts";
import { formatAge, moduleFreshness } from "../src/render/status.ts";

const REFRESH_TOKEN_NAME = "NETATMO_REFRESH_TOKEN";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const KNOWN_DASHBOARD_KEYS = new Set([
	"time_utc", "Temperature", "Humidity", "CO2", "Noise", "Pressure", "AbsolutePressure", "min_temp", "max_temp",
	"date_min_temp", "date_max_temp", "temp_trend", "pressure_trend", "Rain", "sum_rain_1", "sum_rain_24",
	"WindStrength", "WindAngle", "GustStrength", "GustAngle", "max_wind_str", "max_wind_angle", "date_max_wind_str",
]);

// ---------------------------------------------------------------------------------------
// Persisting the rotated refresh token
// ---------------------------------------------------------------------------------------

export interface PersistReport {
	readonly where: "secretspec" | "file";
	/** Only set for "file". */
	readonly path?: string;
}

/**
 * Credential store for the probe: reads the env values once, and on `save` (called by the
 * token manager right after a successful refresh) writes the NEW refresh token away.
 */
export class ProbeStore implements CredentialStore {
	current: StoredCredentials;
	report: PersistReport | undefined;
	/** True when the LAST `save` failed on both routes: the rotated token exists nowhere but in memory. */
	persistFailed = false;
	private readonly runSecretspec: (token: string) => { ok: boolean };
	private readonly tempRoot: string;

	constructor(initial: StoredCredentials, runSecretspec: (token: string) => { ok: boolean } = defaultSecretspecSet, tempRoot: string = os.tmpdir()) {
		this.current = initial;
		this.runSecretspec = runSecretspec;
		this.tempRoot = tempRoot;
	}

	async load(): Promise<StoredCredentials | undefined> {
		return this.current;
	}

	async save(credentials: StoredCredentials): Promise<void> {
		this.current = credentials;
		if (this.runSecretspec(credentials.refreshToken).ok) {
			this.report = { where: "secretspec" };
			this.persistFailed = false;
			return;
		}
		// Fallback: a 0600 file in a private directory. The file is KEPT on purpose (it is the
		// only copy of the rotated token) and its path is reported; a half-written leftover is not.
		let dir: string | undefined;
		try {
			dir = fs.mkdtempSync(path.join(this.tempRoot, "hws-probe-"));
			fs.chmodSync(dir, 0o700);
			const file = path.join(dir, "refresh-token");
			fs.writeFileSync(file, credentials.refreshToken, { flag: "wx", mode: 0o600 });
			fs.chmodSync(file, 0o600);
			this.report = { where: "file", path: file };
			this.persistFailed = false;
		} catch (error) {
			if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
			this.persistFailed = true;
			this.report = undefined;
			// errno class only: the message could name a path, never a token, but keep it terse
			throw new Error(`could not store the rotated refresh token (${(error as NodeJS.ErrnoException).code ?? "error"})`);
		}
	}

	async clear(): Promise<void> {
		// the probe never clears anything
	}
}

/** The value goes through stdin only. Output of the child is discarded (it could echo). */
function defaultSecretspecSet(token: string): { ok: boolean } {
	const result = spawnSync("secretspec", ["set", REFRESH_TOKEN_NAME, "--from-file", "-"], {
		input: token,
		stdio: ["pipe", "ignore", "ignore"],
		timeout: 60_000,
	});
	return { ok: result.status === 0 && !result.error };
}

// ---------------------------------------------------------------------------------------
// Structural summary
// ---------------------------------------------------------------------------------------

function devicesOf(raw: unknown): Json[] {
	return isObject(raw) && isObject(raw.body) && Array.isArray(raw.body.devices) ? raw.body.devices.filter(isObject) : [];
}

/** Types and key NAMES only; used to compare GET and POST responses. */
export function structureSignature(raw: unknown): string {
	const describe = (m: Json) => `${String(m.type)}:${isObject(m.dashboard_data) ? Object.keys(m.dashboard_data).sort().join(",") : "-"}`;
	return devicesOf(raw)
		.map((d) => [describe(d), ...(Array.isArray(d.modules) ? d.modules.filter(isObject).map(describe) : [])].sort().join("|"))
		.sort()
		.join("||");
}

/** Which pressure key is larger, judged against the station's altitude. Reveals no values. */
export function pressureFinding(raw: unknown): string {
	for (const d of devicesOf(raw)) {
		const dash = isObject(d.dashboard_data) ? d.dashboard_data : undefined;
		const place = isObject(d.place) ? d.place : undefined;
		if (!dash || typeof dash.Pressure !== "number" || typeof dash.AbsolutePressure !== "number") continue;
		const altitude = place && typeof place.altitude === "number" ? place.altitude : undefined;
		if (altitude === undefined || altitude < 50) return "inconclusive: station altitude unknown or below 50 m, so sea-level and station pressure are too close to tell apart";
		if (dash.Pressure > dash.AbsolutePressure) return "Pressure is LARGER than AbsolutePressure at an elevated station => Pressure is the sea-level value, AbsolutePressure the station-level one (matches the mapping in parse.ts)";
		if (dash.Pressure < dash.AbsolutePressure) return "Pressure is SMALLER than AbsolutePressure at an elevated station => the labels are SWAPPED relative to parse.ts: swap the two keys there";
		return "inconclusive: both pressure keys are equal";
	}
	return "inconclusive: no base station delivered both Pressure and AbsolutePressure";
}

export function summarise(raw: unknown, nowMs: number): string[] {
	const lines: string[] = [];
	const devices = devicesOf(raw);
	const envelope = isObject(raw) ? raw : {};
	lines.push(`stations: ${devices.length}`);
	if (typeof envelope.time_server === "number" || typeof envelope.time_server === "string") {
		const skew = Math.round(nowMs / 1000 - Number(envelope.time_server));
		if (Number.isFinite(skew)) lines.push(`clock skew local - server: ${skew} s`);
	}
	devices.forEach((device, i) => {
		const mods = [device, ...(Array.isArray(device.modules) ? device.modules.filter(isObject) : [])];
		lines.push(`station #${i + 1}: ${mods.length} module(s) including the base`);
		for (const m of mods) {
			const dash = isObject(m.dashboard_data) ? m.dashboard_data : undefined;
			const timeUtc = dash && typeof dash.time_utc === "number" ? dash.time_utc * 1000 : null;
			const reachable = typeof m.reachable === "boolean" ? m.reachable : null;
			const age = timeUtc === null ? undefined : Math.max(0, nowMs - timeUtc);
			const keys = dash ? Object.keys(dash).filter((k) => KNOWN_DASHBOARD_KEYS.has(k)).sort() : [];
			const unknown = dash ? Object.keys(dash).filter((k) => !KNOWN_DASHBOARD_KEYS.has(k)).sort() : [];
			const fresh = moduleFreshness({ id: "", type: "NAMain", role: "base", name: "", measuredAt: timeUtc, reachable: reachable ?? true, values: {} }, nowMs);
			lines.push(
				`  ${String(m.type)} reachable=${reachable ?? "absent"} dashboard_data=${dash ? "present" : "absent"} age=${age === undefined ? "n/a" : formatAge(age)} freshness=${fresh} battery_percent=${typeof m.battery_percent === "number" ? "present" : "absent"}`,
			);
			lines.push(`    keys: ${keys.join(", ") || "(none)"}`);
			if (unknown.length > 0) lines.push(`    UNKNOWN keys (not mapped by parse.ts): ${unknown.join(", ")}`);
		}
	});
	const admin = isObject(envelope.body) && isObject(envelope.body.user) && isObject(envelope.body.user.administrative) ? envelope.body.user.administrative : undefined;
	if (admin) {
		lines.push(
			`preferences: unit=${String(admin.unit)} windunit=${String(admin.windunit)} pressureunit=${String(admin.pressureunit)} feel_like_algo=${String(admin.feel_like_algo)} lang=${typeof admin.lang === "string" ? "present" : "absent"} reg_locale=${typeof admin.reg_locale === "string" ? "present" : "absent"}`,
		);
	} else lines.push("preferences: body.user.administrative absent");
	return lines;
}

/** A coarse class for the values of a temperature series; the values themselves are never printed. */
function temperatureRangeClass(numbers: readonly number[]): string {
	if (numbers.length === 0) return "none";
	const lo = Math.min(...numbers);
	const hi = Math.max(...numbers);
	if (lo >= -40 && hi <= 60) return "within -40..60 (consistent with degrees Celsius)";
	if (lo >= -40 && hi <= 140) return "within -40..140 but above 60 (CHECK: degrees Fahrenheit?)";
	return "outside -40..140 (CHECK: unit or scale)";
}

/**
 * Structure of one getmeasure response (the JSON envelope): shape, chunks, rows, step, null
 * holes, parsed point count and a value range class. No ids, timestamps or values.
 */
export interface MeasureRequestTimes {
	readonly beginS: number;
	readonly endS: number;
	readonly scaleS: number;
}

/**
 * `request` (date_begin, date_end, scale of the call) adds the observed first/last timestamp
 * RELATIVE to it, never absolute: whether the API reports the bucket start or its middle
 * ("offset + scale/2" in the spec) and whether date_begin/date_end are local or UTC is
 * UNVERIFIED (docs/WEATHER-API.md). Epoch-aligned buckets give (t - begin) mod scale = 0 for
 * bucket starts and scale/2 for middles, provided date_begin itself is aligned.
 */
export function summariseMeasure(raw: unknown, label: string, windowMs: number, request?: MeasureRequestTimes): string[] {
	const lines: string[] = [];
	let body: unknown;
	try {
		body = measureBodyOf(raw);
	} catch (error) {
		return [`${label}: envelope rejected (${isNetatmoError(error) ? error.message : "error"})`];
	}
	const numbers: number[] = [];
	let nulls = 0;
	let rows = 0;
	const note = (cellValue: unknown): void => {
		rows++;
		const v = Array.isArray(cellValue) ? (cellValue as unknown[])[0] : undefined;
		if (v === null) nulls++;
		else if (typeof v === "number" && Number.isFinite(v)) numbers.push(v);
	};
	if (Array.isArray(body)) {
		const steps = new Set<string>();
		for (const chunk of body.filter(isObject)) {
			if (Array.isArray(chunk.value)) chunk.value.forEach(note);
			steps.add(typeof chunk.step_time === "number" ? `${chunk.step_time} s` : "absent");
		}
		lines.push(`${label}: shape = optimised (array), chunks=${body.length}, rows=${rows}, step_time per chunk: ${[...steps].sort().join(", ") || "n/a"}`);
	} else if (isObject(body)) {
		for (const entry of Object.values(body)) note(entry);
		lines.push(`${label}: shape = plain (object keyed by epoch seconds), rows=${rows}`);
	} else {
		return [`${label}: body is neither array nor object`];
	}
	lines.push(`  null holes: ${nulls}; value range class: ${temperatureRangeClass(numbers)}`);
	try {
		const parsed = parseMeasureBody(body, "temperature", 1_800_000);
		const coverage = Math.round(((parsed.points.length * parsed.stepMs) / windowMs) * 100);
		lines.push(`  parser: ${parsed.points.length} point(s), step ${parsed.stepMs / 1000} s, covers about ${coverage}% of the window`);
		const first = parsed.points[0];
		const last = parsed.points[parsed.points.length - 1];
		if (request && first && last) {
			const sign = (n: number): string => (n >= 0 ? `+${n}` : String(n));
			const mod = (t: number): number => ((((t / 1000 - request.beginS) % request.scaleS) + request.scaleS) % request.scaleS);
			lines.push(`  first timestamp: date_begin ${sign(first.t / 1000 - request.beginS)} s, (t - date_begin) mod scale = ${mod(first.t)} s`);
			lines.push(`  last timestamp: date_end ${sign(last.t / 1000 - request.endS)} s, (t - date_begin) mod scale = ${mod(last.t)} s`);
			lines.push(`  read: mod scale 0 = bucket start, scale/2 (${request.scaleS / 2} s) = bucket middle; an offset of about a whole number of hours from date_end hints at local vs UTC`);
		}
	} catch (error) {
		lines.push(`  parser REJECTED the response: ${isNetatmoError(error) ? error.message : "error"}`);
	}
	return lines;
}

// ---------------------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** True when git ignores the path (exit 0 of `git check-ignore -q`); false in every other case, including "not a git repository". */
function gitIgnores(file: string): boolean {
	const result = spawnSync("git", ["check-ignore", "-q", "--", file], { cwd: REPO_ROOT, stdio: "ignore", timeout: 10_000 });
	return result.status === 0 && !result.error;
}

export interface RawOutCheck {
	readonly ok: boolean;
	/** Absolute, symlink-resolved target when ok; the reason when not. */
	readonly value: string;
}

/**
 * The raw response holds personal data (account mail, coordinates, MAC addresses) that no
 * secret scanner recognises, so it must not land where a `git add .` would pick it up:
 * a target inside the repository working tree is refused unless git ignores it. Checked
 * BEFORE any request is sent, because the refresh at the start rotates the token.
 */
export function checkRawOutPath(
	file: string,
	options: { readonly repoRoot?: string; readonly isIgnored?: (absolute: string) => boolean } = {},
): RawOutCheck {
	const isIgnored = options.isIgnored ?? gitIgnores;
	let root: string;
	let dir: string;
	const absolute = path.resolve(file);
	try {
		root = fs.realpathSync(options.repoRoot ?? REPO_ROOT);
		dir = fs.realpathSync(path.dirname(absolute));
	} catch {
		return { ok: false, value: "the directory of --raw-out does not exist" };
	}
	const target = path.join(dir, path.basename(absolute));
	if (fs.existsSync(target)) return { ok: false, value: "--raw-out target already exists; it will not be overwritten" };
	const relative = path.relative(root, target);
	const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
	if (inside && !isIgnored(target)) {
		return {
			ok: false,
			value: "--raw-out points into the repository working tree and git does not ignore it: the file holds personal data and could be committed. Write it outside the repository (for example into the system temp directory) or into an ignored directory.",
		};
	}
	return { ok: true, value: target };
}

function writeRaw(file: string, raw: unknown): void {
	const tmp = `${file}.tmp.${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(raw, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

function isMain(): boolean {
	return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

/** Set in the child so that a failed re-start through secretspec cannot start itself again. */
export const VIA_SECRETSPEC = "PROBE_VIA_SECRETSPEC";

/**
 * How the probe starts itself through secretspec when the three values are missing from the
 * environment: `secretspec run -- node scripts/probe-api.ts <args>`. If no provider is chosen
 * (SECRETSPEC_PROVIDER unset) and the local dotenv file exists, that file is the provider, as
 * documented in secretspec.toml. Nothing secret is read here.
 */
export function secretspecInvocation(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	repoRoot: string,
	fileExists: (p: string) => boolean = fs.existsSync,
): { readonly command: string; readonly args: string[]; readonly env: NodeJS.ProcessEnv } {
	const dotenv = path.join(repoRoot, ".env.local");
	const childEnv: NodeJS.ProcessEnv = { ...env, [VIA_SECRETSPEC]: "1" };
	if (!childEnv.SECRETSPEC_PROVIDER && fileExists(dotenv)) childEnv.SECRETSPEC_PROVIDER = `dotenv://${dotenv}`;
	return { command: "secretspec", args: ["run", "--", "node", path.join(repoRoot, "scripts", "probe-api.ts"), ...argv], env: childEnv };
}

export interface ProbeDeps {
	/** Replaces the re-start through secretspec (tests). Returns the child's exit code, or undefined when secretspec cannot be started. */
	readonly reexec?: (invocation: ReturnType<typeof secretspecInvocation>) => number | undefined;
	/** Tests point this at a local double. */
	readonly baseUrl?: string;
	readonly runSecretspec?: (token: string) => { ok: boolean };
	/** Directory for the fallback token file; default: the system temp directory. Tests point it somewhere broken. */
	readonly tempRoot?: string;
	/** Tests replace the git lookup and the repository root. */
	readonly isIgnored?: (absolute: string) => boolean;
	readonly repoRoot?: string;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, deps: ProbeDeps = {}): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		allowPositionals: false,
		options: {
			"raw-out": { type: "string" },
			"no-post-check": { type: "boolean", default: false },
			history: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.error("usage: npm run probe [-- --raw-out <file>] [--no-post-check] [--history]   (starts itself through `secretspec run` when the NETATMO_* values are not set; with no SECRETSPEC_PROVIDER the local .env.local is used)");
		return 0;
	}
	let rawOut: string | undefined;
	if (values["raw-out"] !== undefined) {
		const check = checkRawOutPath(values["raw-out"], { repoRoot: deps.repoRoot, isIgnored: deps.isIgnored });
		if (!check.ok) {
			console.error(`refused: ${check.value}`);
			return 1;
		}
		rawOut = check.value;
	}
	const clientId = env.NETATMO_CLIENT_ID;
	const clientSecret = env.NETATMO_CLIENT_SECRET;
	const refreshToken = env[REFRESH_TOKEN_NAME];
	if (!clientId || !clientSecret || !refreshToken) {
		if (env[VIA_SECRETSPEC] !== "1") {
			// Not started through secretspec: do it ourselves once, so `npm run probe` just works.
			const invocation = secretspecInvocation(argv, env, deps.repoRoot ?? REPO_ROOT);
			const run =
				deps.reexec ??
				((i: ReturnType<typeof secretspecInvocation>) => {
					const r = spawnSync(i.command, i.args, { env: i.env, stdio: "inherit" });
					return r.error ? undefined : (r.status ?? 1);
				});
			console.error("probe: the NETATMO_* values are not in the environment; starting through `secretspec run` ...");
			const code = run(invocation);
			if (code !== undefined) return code;
			console.error("probe: `secretspec` could not be started (is it installed? `devenv shell` provides it).");
		}
		console.error("NETATMO_CLIENT_ID, NETATMO_CLIENT_SECRET and NETATMO_REFRESH_TOKEN must be set (see secretspec.toml; run via `secretspec run -- npm run probe`).");
		return 1;
	}
	const secrets = [clientSecret, refreshToken];
	const store = new ProbeStore({ clientId, clientSecret, refreshToken }, deps.runSecretspec, deps.tempRoot);
	const tokens = new TokenManager({ store, baseUrl: deps.baseUrl, logger: { debug() {}, info() {}, warn() {}, error: (m) => console.error(`token manager: ${redactSecrets(m, secrets)}`) } });
	const client = new NetatmoClient({ tokens, baseUrl: deps.baseUrl, logger: { debug() {}, info() {}, warn() {}, error() {} } });
	let exit = 0;
	try {
		const raw = await client.getStationsDataRaw({ method: "GET" });
		reportPersistence(store);
		console.log("GET /api/getstationsdata?get_favorites=false: ok");
		for (const line of summarise(raw, Date.now())) console.log(line);
		console.log(`pressure keys: ${pressureFinding(raw)}`);
		const snapshot = parseStationsResponse(raw, Date.now());
		console.log(`parser: ${snapshot.stations.length} station(s), ${snapshot.stations.reduce((n, s) => n + s.modules.length, 0)} module(s) understood`);

		if (!values["no-post-check"]) {
			try {
				const viaPost = await client.getStationsDataRaw({ method: "POST" });
				const same = structureSignature(viaPost) === structureSignature(raw);
				console.log(`POST /api/getstationsdata: accepted; same structure as GET: ${same ? "yes" : "NO (differs)"}`);
			} catch (error) {
				console.log(`POST /api/getstationsdata: not usable (${isNetatmoError(error) ? `${error.kind}${error.status ? ` HTTP ${error.status}` : ""}` : "error"})`);
			}
		}
		if (values.history) await probeHistory(client, snapshot);
		if (rawOut !== undefined) {
			writeRaw(rawOut, raw);
			console.error(`WARNING: the raw response was written to ${rawOut} (mode 0600). It contains personal data (account mail, location, device ids). Run \`npm run capture:fixture\` on it, then DELETE it.`);
		}
	} catch (error) {
		reportPersistence(store);
		if (isNetatmoError(error)) {
			console.error(`${error.kind} error${error.status ? ` (HTTP ${error.status}${error.code ? `, code ${error.code}` : ""})` : ""}: ${redactSecrets(error.message, secrets)}`);
			exit = error.kind === "auth" ? 2 : 1;
		} else {
			console.error("unexpected error while probing");
			exit = 1;
		}
	}
	if (store.persistFailed) {
		console.error("The rotated refresh token could NOT be stored (secretspec set failed and so did the temporary file). The old one is invalid: sign in again and create a new token pair.");
		if (exit === 0) exit = 1;
	}
	return exit;
}

/** 24 h of temperature of the first base module, optimised and plain; structure only. A failure is reported, never fatal. */
async function probeHistory(client: NetatmoClient, snapshot: ReturnType<typeof parseStationsResponse>): Promise<void> {
	const station = snapshot.stations.find((s) => s.modules.some((m) => m.role === "base"));
	const base = station?.modules.find((m) => m.role === "base");
	if (!station || !base) {
		console.log("history: no base module in the response, nothing to probe");
		return;
	}
	const request: HistoryRequest = { stationId: station.id, moduleId: base.id, metric: "temperature", window: "24h" };
	const query = buildMeasureQuery(request, Date.now());
	const variants: Array<[string, string]> = [["optimize=true", query], ["optimize=false", query.replace("optimize=true", "optimize=false")]];
	for (const [label, q] of variants) {
		try {
			const raw = await client.getMeasure(q);
			const params = new URLSearchParams(q);
			const times: MeasureRequestTimes = { beginS: Number(params.get("date_begin")), endS: Number(params.get("date_end")), scaleS: scaleMs(scaleFor(request)) / 1000 };
			for (const line of summariseMeasure(raw, `GET /api/getmeasure (temperature, 24 h, 30min, ${label})`, 24 * 3_600_000, times)) console.log(line);
		} catch (error) {
			console.log(`GET /api/getmeasure (${label}): failed (${isNetatmoError(error) ? `${error.kind}${error.status ? ` HTTP ${error.status}` : ""}` : "error"})`);
		}
	}
}

function reportPersistence(store: ProbeStore): void {
	if (!store.report) return;
	if (store.report.where === "secretspec") {
		console.error(`rotated refresh token stored via \`secretspec set ${REFRESH_TOKEN_NAME}\`. The previous value is now INVALID.`);
	} else {
		console.error(`secretspec set failed; the rotated refresh token was written to ${store.report.path} (mode 0600). The previous value is now INVALID: store this one (secretspec set ${REFRESH_TOKEN_NAME} --from-file ${store.report.path}) and delete the file.`);
	}
}

if (isMain()) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		() => {
			console.error("probe crashed");
			process.exit(1);
		},
	);
}

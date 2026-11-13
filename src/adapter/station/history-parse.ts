/**
 * Pure helpers for the history key: request mapping and strict parsing of a getmeasure
 * response. No I/O, no clock. See docs/WEATHER-API.md ("Endpoint: getmeasure") for the
 * shapes; both are derived from the documentation and from pyatmo/Home Assistant code, not
 * from a captured live response (UNVERIFIED).
 *
 * Two response shapes exist:
 *   optimize=true   body: [ { beg_time, step_time, value: [[v], [v], ...] }, ... ]
 *                   a new chunk starts after a gap; `step_time` may be absent for a chunk
 *                   with a single value; a `null` inside `[v]` is a hole.
 *   optimize=false  body: { "<epoch seconds>": [v], ... }
 * Timestamps: `HistoryPoint.t` is the timestamp exactly as the API reports it. With
 * real_time=false the spec documents it as "offset + scale/2", the MIDDLE of the bucket
 * (UNVERIFIED against a live response; `npm run probe -- --history` prints the observed
 * offsets). The parser does not shift it. Both are accepted. Strict means: any structural surprise (wrong type, non-finite number,
 * too many points) rejects the whole response; a finite number outside the plausible range
 * of the metric is dropped like a hole, mirroring parse.ts.
 */

import { NetatmoError } from "./errors.ts";
import type { HistoryMetric, HistoryPoint, HistoryRequest, HistoryWindow, ModuleType } from "./types.ts";

/** Upper bound of points we accept in total (3 d at 30 min is 144; this is a sanity net). */
export const MAX_HISTORY_POINTS = 2000;
/** Upper bound of chunks in the optimised shape. */
export const MAX_HISTORY_CHUNKS = 400;

export interface MeasureSpec {
	/**
	 * Netatmo `type` parameter, in the spelling of the OpenAPI spec (lowercase: `temperature`,
	 * `co2`, `windstrength`, `sum_rain`; docs/WEATHER-API.md). Whether the service also
	 * accepts the capitalised spelling is not known and not relied on.
	 */
	readonly type: string;
	readonly min: number;
	readonly max: number;
}

export const MEASURE_SPECS: Readonly<Record<HistoryMetric, MeasureSpec>> = {
	temperature: { type: "temperature", min: -90, max: 70 },
	humidity: { type: "humidity", min: 0, max: 100 },
	co2: { type: "co2", min: 0, max: 100_000 },
	noise: { type: "noise", min: 0, max: 200 },
	pressure: { type: "pressure", min: 300, max: 1200 },
	rain: { type: "sum_rain", min: 0, max: 10_000 },
	windStrength: { type: "windstrength", min: 0, max: 500 },
};

/** Which history metrics a module type reports (the same set as its dashboard_data, see WEATHER-API.md). */
export const SUPPORTED_BY_MODULE: Readonly<Record<ModuleType, readonly HistoryMetric[]>> = {
	NAMain: ["temperature", "humidity", "co2", "noise", "pressure"],
	NAModule1: ["temperature", "humidity"],
	NAModule2: ["windStrength"],
	NAModule3: ["rain"],
	NAModule4: ["temperature", "humidity", "co2"],
};

export const WINDOW_MS: Readonly<Record<HistoryWindow, number>> = {
	"6h": 6 * 3_600_000,
	"24h": 24 * 3_600_000,
	"3d": 72 * 3_600_000,
};

export type MeasureScale = "30min" | "1hour";

const SCALE_MS: Readonly<Record<MeasureScale, number>> = { "30min": 1_800_000, "1hour": 3_600_000 };

export function scaleFor(request: Pick<HistoryRequest, "metric" | "window">): MeasureScale {
	return request.metric === "rain" || request.window === "3d" ? "1hour" : "30min";
}

export function scaleMs(scale: MeasureScale): number {
	return SCALE_MS[scale];
}

/**
 * Query string of GET /api/getmeasure. `module_id` is omitted for the base module (its id
 * equals the station id). Order is fixed so tests can compare the exact string.
 */
export function buildMeasureQuery(request: HistoryRequest, nowMs: number): string {
	const spec = MEASURE_SPECS[request.metric];
	const end = Math.floor(nowMs / 1000);
	const begin = end - Math.floor(WINDOW_MS[request.window] / 1000);
	const params = new URLSearchParams();
	params.set("device_id", request.stationId);
	if (request.moduleId !== request.stationId) params.set("module_id", request.moduleId);
	params.set("scale", scaleFor(request));
	params.set("type", spec.type);
	params.set("date_begin", String(begin));
	params.set("date_end", String(end));
	params.set("optimize", "true");
	params.set("real_time", "false");
	return params.toString();
}

export interface ParsedMeasure {
	readonly points: readonly HistoryPoint[];
	readonly stepMs: number;
}

const bad = (why: string): NetatmoError => new NetatmoError("protocol", `Unexpected history response (${why})`);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Epoch seconds: a positive finite integer in a sane range (year 2001 .. 2100). */
function epochSeconds(v: unknown, what: string): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1_000_000_000 || v > 4_100_000_000) throw bad(what);
	return v;
}

/** One cell `[v]`: null is a hole (undefined), a finite number is a value, anything else is malformed. */
function cell(entry: unknown, spec: MeasureSpec): number | undefined {
	if (!Array.isArray(entry) || entry.length < 1 || entry.length > 8) throw bad("value row");
	const v: unknown = entry[0];
	if (v === null) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v)) throw bad("value type");
	return v >= spec.min && v <= spec.max ? v : undefined;
}

/**
 * Parse the `body` of a getmeasure response. `defaultStepMs` is used when the response does
 * not say (a lone value, an empty body). Throws NetatmoError("protocol") on malformed input.
 */
export function parseMeasureBody(body: unknown, metric: HistoryMetric, defaultStepMs: number): ParsedMeasure {
	const spec = MEASURE_SPECS[metric];
	const points: HistoryPoint[] = [];
	let stepMs: number | undefined;
	const noteStep = (candidate: number): void => {
		stepMs = stepMs === undefined ? candidate : Math.min(stepMs, candidate);
	};

	if (Array.isArray(body)) {
		if (body.length > MAX_HISTORY_CHUNKS) throw bad("too many chunks");
		for (const chunk of body) {
			if (!isObject(chunk)) throw bad("chunk");
			const begin = epochSeconds(chunk.beg_time, "beg_time");
			const rows = chunk.value;
			if (!Array.isArray(rows)) throw bad("value list");
			if (points.length + rows.length > MAX_HISTORY_POINTS) throw bad("too many points");
			let step = defaultStepMs / 1000;
			if (chunk.step_time !== undefined) {
				const s = chunk.step_time;
				if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > 86_400) throw bad("step_time");
				step = s;
				noteStep(s * 1000);
			} else if (rows.length > 1) {
				throw bad("step_time missing");
			}
			rows.forEach((row, i) => {
				const v = cell(row, spec);
				if (v !== undefined) points.push({ t: (begin + i * step) * 1000, v });
			});
		}
	} else if (isObject(body)) {
		const keys = Object.keys(body);
		if (keys.length > MAX_HISTORY_POINTS) throw bad("too many points");
		for (const key of keys) {
			if (!/^\d{10}$/.test(key)) throw bad("timestamp key");
			const t = epochSeconds(Number(key), "timestamp key");
			const v = cell(body[key], spec);
			if (v !== undefined) points.push({ t: t * 1000, v });
		}
		points.sort((a, b) => a.t - b.t);
		// the step is the smallest spacing seen; it lets the renderer tell a gap from a normal step
		for (let i = 1; i < points.length; i++) noteStep(points[i]!.t - points[i - 1]!.t);
	} else {
		throw bad("body");
	}

	points.sort((a, b) => a.t - b.t);
	const unique = points.filter((p, i) => i === 0 || p.t !== points[i - 1]!.t);
	return { points: unique, stepMs: stepMs !== undefined && stepMs > 0 ? stepMs : defaultStepMs };
}

/** Validates the envelope and returns its body; `status` must be "ok" when present. */
export function measureBodyOf(json: unknown): unknown {
	if (!isObject(json)) throw bad("envelope");
	if (json.status !== undefined && json.status !== "ok") throw bad("status");
	if (!("body" in json)) throw bad("no body");
	return json.body;
}

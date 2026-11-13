import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { BUDGET_LONG_LIMIT, BUDGET_POLLER_RESERVE, BUDGET_SHORT_LIMIT, RequestBudget } from "../src/adapter/station/budget.ts";
import { NetatmoClient } from "../src/adapter/station/client.ts";
import { MemoryCredentialStore } from "../src/adapter/station/credentials.ts";
import { createWeatherService } from "../src/adapter/station/create-service.ts";
import { NetatmoError } from "../src/adapter/station/errors.ts";
import { HISTORY_CACHE_TTL_MS, HISTORY_MIN_INTERVAL_MS, HistoryService } from "../src/adapter/station/history.ts";
import { MAX_HISTORY_POINTS, MEASURE_SPECS, buildMeasureQuery, measureBodyOf, parseMeasureBody } from "../src/adapter/station/history-parse.ts";
import { parseStationsResponse } from "../src/adapter/station/parse.ts";
import type { WeatherService } from "../src/adapter/station/service.ts";
import { TokenManager } from "../src/adapter/station/token-manager.ts";
import type { HistoryRequest, HistoryResult } from "../src/adapter/station/types.ts";
import { FakeClock, RecordingLogger, T0, fixture, makeTempDir, sendJson, startApiDouble, stationsOk, tokenIssuer } from "./station-helpers.ts";

const TOKEN = "POST /oauth2/token";
const STATIONS = "GET /api/getstationsdata";
const MEASURE = "GET /api/getmeasure";
const input = { clientId: "client-id-0001", clientSecret: "client-secret-0001", refreshToken: "pasted-refresh-0001" };

const BASE = "00:00:5e:00:53:01";
const OUTDOOR = "00:00:5e:00:53:02";
const WIND = "00:00:5e:00:53:03";
const RAIN = "00:00:5e:00:53:04";
const temp24 = (over: Partial<HistoryRequest> = {}): HistoryRequest => ({ stationId: BASE, moduleId: BASE, metric: "temperature", window: "24h", ...over });

const MIN = 60_000;
const STEP = 1_800_000;
/** The series both measure-*.json fixtures describe (hole at 1699991800 + 1800 s is a null, gap before 1699997200). */
const EXPECTED = [
	{ t: 1_699_988_200_000, v: 9.8 },
	{ t: 1_699_991_800_000, v: 10.1 },
	{ t: 1_699_993_600_000, v: 10.4 },
	{ t: 1_699_997_200_000, v: 11.0 },
	{ t: 1_699_999_000_000, v: 11.3 },
];

async function make(t: TestContext, stations = "stations-full") {
	const api = await startApiDouble(t);
	const dataDir = await makeTempDir(t);
	const clock = new FakeClock();
	const service = createWeatherService({ baseUrl: api.baseUrl, dataDir, logger: new RecordingLogger(), random: () => 0.5, now: clock.now });
	t.after(() => service.dispose());
	api.route(TOKEN, tokenIssuer());
	api.route(STATIONS, stationsOk(fixture(stations)));
	const signedIn = await service.setCredentials(input);
	assert.ok(signedIn.ok, "setup: sign-in must succeed");
	return { api, clock, service, dataDir };
}

const measureOk = (name = "measure-optimised") => (_req: unknown, res: import("node:http").ServerResponse) => sendJson(res, 200, fixture(name));

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(check(), "condition not reached");
}

function expectError(result: HistoryResult, reason: string): Extract<HistoryResult, { kind: "error" }> {
	assert.equal(result.kind, "error");
	assert.ok(result.kind === "error");
	assert.equal(result.reason, reason);
	return result;
}

describe("history: request mapping", () => {
	it("builds the exact query for the base module (module_id omitted)", () => {
		assert.equal(
			buildMeasureQuery(temp24(), T0),
			"device_id=00%3A00%3A5e%3A00%3A53%3A01&scale=30min&type=temperature&date_begin=1699913700&date_end=1700000100&optimize=true&real_time=false",
		);
	});
	it("adds module_id for other modules, 1hour for 3d and for rain, the API type names", () => {
		assert.equal(
			buildMeasureQuery(temp24({ moduleId: OUTDOOR, window: "3d" }), T0),
			"device_id=00%3A00%3A5e%3A00%3A53%3A01&module_id=00%3A00%3A5e%3A00%3A53%3A02&scale=1hour&type=temperature&date_begin=1699740900&date_end=1700000100&optimize=true&real_time=false",
		);
		assert.match(buildMeasureQuery(temp24({ moduleId: RAIN, metric: "rain", window: "6h" }), T0), /&scale=1hour&type=sum_rain&date_begin=1699978500&/);
		assert.match(buildMeasureQuery(temp24({ moduleId: WIND, metric: "windStrength" }), T0), /&scale=30min&type=windstrength&/);
		assert.match(buildMeasureQuery(temp24({ metric: "co2", window: "6h" }), T0), /&scale=30min&type=co2&/);
		assert.match(buildMeasureQuery(temp24({ metric: "noise" }), T0), /&type=noise&/);
		assert.match(buildMeasureQuery(temp24({ metric: "pressure" }), T0), /&type=pressure&/);
		assert.match(buildMeasureQuery(temp24({ metric: "humidity" }), T0), /&type=humidity&/);
	});
});

describe("history: type table", () => {
	it("equals the lowercase spelling of the OpenAPI spec", () => {
		// Source: scratchpad research-netatmo-docs.md, section "GET /getmeasure" (read from the live
		// OpenAPI spec on 2026-11-13): "`type` values: Temperature (degC): `temperature` ...
		// Humidity: `humidity` ... CO2: `co2` ... Pressure: `pressure` ... Noise: `noise` ...
		// Rain: `rain`, `min_rain`, `max_rain`, `sum_rain` ... Wind: `windstrength`, `windangle`,
		// `guststrength`, `gustangle`". The plugin sums rain per bucket, hence `sum_rain`.
		const types = Object.fromEntries(Object.entries(MEASURE_SPECS).map(([k, v]) => [k, v.type]));
		assert.deepEqual(types, {
			temperature: "temperature",
			humidity: "humidity",
			co2: "co2",
			noise: "noise",
			pressure: "pressure",
			rain: "sum_rain",
			windStrength: "windstrength",
		});
		for (const type of Object.values(types)) assert.equal(type, type.toLowerCase());
	});
	it("passes timestamps through unshifted (documented as bucket middle)", () => {
		const parsed = parseMeasureBody({ "1700000100": [1] }, "humidity", STEP);
		assert.equal(parsed.points[0]!.t, 1_700_000_100_000);
	});
});

describe("history: parsing", () => {
	it("optimised shape: chunks, null holes and the gap between chunks", () => {
		const parsed = parseMeasureBody(measureBodyOf(fixture("measure-optimised")), "temperature", STEP);
		assert.deepEqual(parsed.points, EXPECTED);
		assert.equal(parsed.stepMs, STEP);
		assert.ok(!parsed.points.some((p) => p.t === 1_699_990_000_000), "a null cell leaves a hole, not a point");
		assert.ok(!parsed.points.some((p) => p.t === 1_699_995_400_000), "the gap between chunks stays a gap");
	});
	it("non-optimised shape gives the same points and infers the step from the spacing", () => {
		const parsed = parseMeasureBody(measureBodyOf(fixture("measure-plain")), "temperature", 3_600_000);
		assert.deepEqual(parsed.points, EXPECTED);
		assert.equal(parsed.stepMs, 1_800_000, "smallest spacing, not the 1 h default");
	});
	it("sorts unordered keys of the plain shape", () => {
		const parsed = parseMeasureBody({ "1700000200": [2], "1700000100": [1] }, "humidity", STEP);
		assert.deepEqual(parsed.points, [{ t: 1_700_000_100_000, v: 1 }, { t: 1_700_000_200_000, v: 2 }]);
	});
	it("empty bodies are ok and carry the default step", () => {
		for (const body of [[], {}]) assert.deepEqual(parseMeasureBody(body, "temperature", STEP), { points: [], stepMs: STEP });
	});
	it("a chunk with one value may omit step_time", () => {
		const parsed = parseMeasureBody([{ beg_time: 1_700_000_000, value: [[5]] }], "temperature", STEP);
		assert.deepEqual(parsed.points, [{ t: 1_700_000_000_000, v: 5 }]);
	});
	it("drops implausible numbers like holes", () => {
		const parsed = parseMeasureBody([{ beg_time: 1_700_000_000, step_time: 1800, value: [[5], [999], [-200], [6]] }], "temperature", STEP);
		assert.deepEqual(parsed.points.map((p) => p.v), [5, 6]);
	});
	it("rejects structural surprises as protocol errors", () => {
		const cases: Array<[string, unknown]> = [
			["string value", [{ beg_time: 1_700_000_000, step_time: 1800, value: [["12"]] }]],
			["bare number row", [{ beg_time: 1_700_000_000, step_time: 1800, value: [12] }]],
			["empty row", [{ beg_time: 1_700_000_000, step_time: 1800, value: [[]] }]],
			["zero step", [{ beg_time: 1_700_000_000, step_time: 0, value: [[1], [2]] }]],
			["fractional step", [{ beg_time: 1_700_000_000, step_time: 1.5, value: [[1], [2]] }]],
			["missing step with two values", [{ beg_time: 1_700_000_000, value: [[1], [2]] }]],
			["beg_time in milliseconds", [{ beg_time: 1_700_000_000_000, step_time: 1800, value: [[1]] }]],
			["beg_time string", [{ beg_time: "1700000000", step_time: 1800, value: [[1]] }]],
			["value not a list", [{ beg_time: 1_700_000_000, step_time: 1800, value: 3 }]],
			["chunk not an object", [3]],
			["plain key not epoch", { yesterday: [1] }],
			["plain value string", { "1700000000": ["x"] }],
			["body a string", "nope"],
			["body null", null],
		];
		for (const [name, body] of cases) {
			assert.throws(() => parseMeasureBody(body, "temperature", STEP), (e) => e instanceof NetatmoError && e.kind === "protocol", name);
		}
	});
	it("bounds the number of points and chunks", () => {
		const rows = Array.from({ length: MAX_HISTORY_POINTS + 1 }, () => [1]);
		assert.throws(() => parseMeasureBody([{ beg_time: 1_700_000_000, step_time: 60, value: rows }], "temperature", STEP), NetatmoError);
		const plain: Record<string, number[]> = {};
		for (let i = 0; i <= MAX_HISTORY_POINTS; i++) plain[String(1_700_000_000 + i)] = [1];
		assert.throws(() => parseMeasureBody(plain, "temperature", STEP), NetatmoError);
		const chunks = Array.from({ length: 401 }, (_v, i) => ({ beg_time: 1_700_000_000 + i * 10, value: [[1]] }));
		assert.throws(() => parseMeasureBody(chunks, "temperature", STEP), NetatmoError);
		const ok = Array.from({ length: MAX_HISTORY_POINTS }, () => [1]);
		assert.equal(parseMeasureBody([{ beg_time: 1_700_000_000, step_time: 60, value: ok }], "temperature", STEP).points.length, MAX_HISTORY_POINTS);
	});
	it("the envelope must be an object with status ok (when present) and a body", () => {
		assert.throws(() => measureBodyOf(null), NetatmoError);
		assert.throws(() => measureBodyOf({ status: "error", body: [] }), NetatmoError);
		assert.throws(() => measureBodyOf({ status: "ok" }), NetatmoError);
		assert.deepEqual(measureBodyOf({ body: [] }), []);
	});
});

describe("history: request budget", () => {
	it("refuses optional requests at 50 per 10 s and keeps a poller reserve of the hourly budget", () => {
		const b = new RequestBudget();
		for (let i = 0; i < BUDGET_SHORT_LIMIT - 1; i++) b.record(T0);
		assert.deepEqual(b.check(T0), { ok: true });
		b.record(T0);
		const short = b.check(T0 + 1000);
		assert.ok(!short.ok && short.retryAt === T0 + 10_000);
		assert.deepEqual(b.check(T0 + 10_001), { ok: true });

		const hourly = new RequestBudget();
		const allowed = BUDGET_LONG_LIMIT - BUDGET_POLLER_RESERVE;
		for (let i = 0; i < allowed; i++) hourly.record(T0 + i * 5_000);
		const late = T0 + allowed * 5_000;
		assert.ok(!hourly.check(late).ok, "the reserve is kept for the poller");
		assert.deepEqual(hourly.check(late, 0), { ok: true }, "without a reserve there is room");
		assert.deepEqual(hourly.check(T0 + 3_600_001 + allowed * 5_000), { ok: true }, "old entries age out");
	});
	it("getMeasure sends nothing when the budget is used up, and counts what it sends", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		api.route(MEASURE, measureOk());
		const budget = new RequestBudget();
		const tokens = new TokenManager({ store: new MemoryCredentialStore({ clientId: "c", clientSecret: "s", refreshToken: "r" }), baseUrl: api.baseUrl, logger: new RecordingLogger() });
		const client = new NetatmoClient({ tokens, baseUrl: api.baseUrl, budget, now: () => T0, logger: new RecordingLogger() });
		await client.getMeasure("device_id=x");
		assert.equal(budget.used, 1);
		for (let i = 0; i < BUDGET_SHORT_LIMIT; i++) budget.record(T0);
		await assert.rejects(client.getMeasure("device_id=x"), (e) => e instanceof NetatmoError && e.kind === "rate-limited" && e.retryAt === T0 + 10_000);
		assert.equal(api.requestsTo(MEASURE).length, 1);
	});
});

describe("HistoryService: cache, coalescing, throttle, generations (fake client)", () => {
	function setup() {
		const snapshot = parseStationsResponse(fixture("stations-full"), T0);
		const clock = new FakeClock();
		const calls: Array<{ query: string; signal: AbortSignal | undefined }> = [];
		let impl: (query: string) => Promise<unknown> = async () => fixture("measure-optimised");
		const service = new HistoryService({
			client: {
				getMeasure: (query, options) => {
					calls.push({ query, signal: options?.signal });
					return impl(query);
				},
			},
			getSnapshot: () => snapshot,
			hasCredentials: async () => true,
			now: clock.now,
			logger: new RecordingLogger(),
		});
		return { service, clock, calls, setImpl: (f: typeof impl) => void (impl = f) };
	}

	it("serves a repeat from the cache until 10 minutes have passed", async () => {
		const { service, clock, calls } = setup();
		const first = await service.getHistory(temp24());
		assert.equal(first.kind, "ok");
		assert.ok(first.kind === "ok" && first.fetchedAt === T0 && first.stepMs === STEP);
		clock.nowMs += HISTORY_CACHE_TTL_MS - 1;
		assert.equal(await service.getHistory(temp24()), first);
		assert.equal(calls.length, 1);
		clock.nowMs += 1;
		await service.getHistory(temp24());
		assert.equal(calls.length, 2, "expired: one more request");
	});

	it("keys the cache by station, module, metric and window", async () => {
		const { service, calls } = setup();
		await service.getHistory(temp24());
		await service.getHistory(temp24({ window: "6h" }));
		await service.getHistory(temp24({ metric: "humidity" }));
		await service.getHistory(temp24({ moduleId: OUTDOOR }));
		assert.equal(calls.length, 4);
	});

	it("coalesces concurrent identical requests into one call", async () => {
		const { service, calls, setImpl } = setup();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		setImpl(async () => {
			await gate;
			return fixture("measure-plain");
		});
		const all = [service.getHistory(temp24()), service.getHistory(temp24()), service.getHistory(temp24())];
		release();
		const results = await Promise.all(all);
		assert.equal(calls.length, 1);
		assert.ok(results.every((r) => r === results[0]));
	});

	it("throttles after a failure: one real request per combination per 30 s", async () => {
		const { service, clock, calls, setImpl } = setup();
		setImpl(async () => {
			throw new NetatmoError("transient", "The service is unavailable (HTTP 503)", { status: 503 });
		});
		const first = expectError(await service.getHistory(temp24()), "transient");
		assert.match(first.message, /unavailable/);
		clock.nowMs += HISTORY_MIN_INTERVAL_MS - 1;
		expectError(await service.getHistory(temp24()), "transient");
		assert.equal(calls.length, 1, "the failure is remembered for 30 s");
		setImpl(async () => fixture("measure-optimised"));
		clock.nowMs += 1;
		assert.equal((await service.getHistory(temp24())).kind, "ok");
		assert.equal(calls.length, 2);
	});

	it("a rate-limit failure is remembered until retryAt, capped at the cache lifetime", async () => {
		const { service, clock, calls, setImpl } = setup();
		setImpl(async () => {
			throw new NetatmoError("rate-limited", "The service is rate limiting requests", { status: 429, retryAt: T0 + 5 * MIN });
		});
		expectError(await service.getHistory(temp24()), "rate");
		clock.nowMs += 4 * MIN;
		expectError(await service.getHistory(temp24()), "rate");
		assert.equal(calls.length, 1);
		clock.nowMs += MIN;
		setImpl(async () => fixture("measure-optimised"));
		assert.equal((await service.getHistory(temp24())).kind, "ok");
		assert.equal(calls.length, 2);
	});

	it("maps error kinds to reasons; foreign errors become a generic transient message", async () => {
		const { service, setImpl } = setup();
		setImpl(async () => {
			throw new NetatmoError("auth", "The service rejected the credentials. Sign in again.");
		});
		expectError(await service.getHistory(temp24()), "auth");
		setImpl(async () => {
			throw new NetatmoError("protocol", "Unexpected response from the service (HTTP 418)");
		});
		expectError(await service.getHistory(temp24({ metric: "humidity" })), "transient");
		setImpl(async () => {
			throw new Error("secret detail 00:00:5e:00:53:01");
		});
		const e = expectError(await service.getHistory(temp24({ metric: "co2" })), "transient");
		assert.ok(!e.message.includes("secret detail"));
	});

	it("a malformed response is a transient error, not a crash", async () => {
		const { service, setImpl } = setup();
		setImpl(async () => ({ status: "ok", body: [{ beg_time: "x" }] }));
		expectError(await service.getHistory(temp24()), "transient");
	});

	it("unsupported combinations and unknown ids never reach the client", async () => {
		const { service, calls } = setup();
		expectError(await service.getHistory(temp24({ metric: "rain" })), "unsupported");
		expectError(await service.getHistory(temp24({ moduleId: OUTDOOR, metric: "co2" })), "unsupported");
		expectError(await service.getHistory(temp24({ moduleId: WIND, metric: "temperature" })), "unsupported");
		expectError(await service.getHistory(temp24({ moduleId: RAIN, metric: "windStrength" })), "unsupported");
		expectError(await service.getHistory(temp24({ moduleId: "00:00:5e:00:53:99" })), "unsupported");
		expectError(await service.getHistory(temp24({ stationId: "00:00:5e:00:53:99" })), "unsupported");
		expectError(await service.getHistory({ ...temp24(), metric: "tempMin" as never }), "unsupported");
		expectError(await service.getHistory({ ...temp24(), window: "1y" as never }), "unsupported");
		expectError(await service.getHistory({ ...temp24(), metric: "__proto__" as never }), "unsupported");
		assert.equal(calls.length, 0);
		assert.equal((await service.getHistory(temp24({ moduleId: RAIN, metric: "rain", window: "6h" }))).kind, "ok");
		assert.equal((await service.getHistory(temp24({ moduleId: WIND, metric: "windStrength" }))).kind, "ok");
	});

	it("without a snapshot: transient, nothing sent", async () => {
		const clock = new FakeClock();
		let sent = 0;
		const service = new HistoryService({
			client: { getMeasure: async () => void sent++ },
			getSnapshot: () => undefined,
			hasCredentials: async () => true,
			now: clock.now,
			logger: new RecordingLogger(),
		});
		expectError(await service.getHistory(temp24()), "transient");
		assert.equal(sent, 0);
	});

	it("invalidate() aborts in flight, discards the late result and empties the cache", async () => {
		const { service, calls, setImpl } = setup();
		await service.getHistory(temp24({ metric: "humidity" }));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		setImpl(async () => {
			await gate;
			return fixture("measure-optimised");
		});
		const pending = service.getHistory(temp24());
		await until(() => calls.length === 2);
		service.invalidate();
		assert.equal(calls[1]!.signal?.aborted, true, "the request is aborted");
		release();
		const late = expectError(await pending, "transient");
		assert.match(late.message, /sign-in changed/i);
		setImpl(async () => fixture("measure-plain"));
		const again = await service.getHistory(temp24());
		assert.equal(again.kind, "ok");
		assert.equal(calls.length, 3, "the discarded result was not cached");
		await service.getHistory(temp24({ metric: "humidity" }));
		assert.equal(calls.length, 4, "invalidate emptied the cache");
	});

	it("a failure under an old generation is discarded too", async () => {
		const { service, calls, setImpl } = setup();
		let fail!: () => void;
		const gate = new Promise<void>((_r, rej) => (fail = () => rej(new NetatmoError("auth", "old credentials rejected"))));
		setImpl(() => gate);
		const pending = service.getHistory(temp24());
		await until(() => calls.length === 1);
		service.invalidate();
		fail();
		const late = expectError(await pending, "transient");
		assert.ok(!/old credentials/.test(late.message));
	});

	it("a signed-out service reports auth without a request", async () => {
		const snapshot = parseStationsResponse(fixture("stations-full"), T0);
		let sent = 0;
		const service = new HistoryService({
			client: { getMeasure: async () => void sent++ },
			getSnapshot: () => snapshot,
			hasCredentials: async () => false,
			now: () => T0,
			logger: new RecordingLogger(),
		});
		expectError(await service.getHistory(temp24()), "auth");
		assert.equal(sent, 0);
	});
});

describe("WeatherService.getHistory against the HTTP double", () => {
	it("sends exactly the documented query with the bearer token and parses the optimised shape", async (t) => {
		const { api, service } = await make(t);
		api.route(MEASURE, measureOk("measure-optimised"));
		const result = await service.getHistory(temp24());
		assert.ok(result.kind === "ok");
		assert.deepEqual(result.points, EXPECTED);
		assert.equal(result.stepMs, STEP);
		assert.equal(result.fetchedAt, T0);
		const req = api.requestsTo(MEASURE)[0]!;
		assert.equal(req.url, "/api/getmeasure?device_id=00%3A00%3A5e%3A00%3A53%3A01&scale=30min&type=temperature&date_begin=1699913700&date_end=1700000100&optimize=true&real_time=false");
		assert.equal(req.headers.authorization, "Bearer fake-access-1");
		assert.equal(req.body, "");
	});

	it("parses the non-optimised shape to the same points", async (t) => {
		const { api, service } = await make(t);
		api.route(MEASURE, measureOk("measure-plain"));
		const result = await service.getHistory(temp24({ window: "3d" }));
		assert.ok(result.kind === "ok");
		assert.deepEqual(result.points, EXPECTED);
		assert.match(api.requestsTo(MEASURE)[0]!.url, /scale=1hour/);
	});

	it("an empty body is an ok result without points", async (t) => {
		const { api, service } = await make(t);
		api.route(MEASURE, (_req, res) => sendJson(res, 200, { status: "ok", body: [] }));
		const result = await service.getHistory(temp24());
		assert.ok(result.kind === "ok" && result.points.length === 0);
	});

	it("cache hit and expiry with the injected clock", async (t) => {
		const { api, clock, service } = await make(t);
		api.route(MEASURE, measureOk());
		await service.getHistory(temp24());
		clock.nowMs += 9 * MIN;
		await service.getHistory(temp24());
		assert.equal(api.requestsTo(MEASURE).length, 1);
		clock.nowMs += MIN + 1;
		await service.getHistory(temp24());
		assert.equal(api.requestsTo(MEASURE).length, 2);
		assert.match(api.requestsTo(MEASURE)[1]!.url, /date_end=1700000700&/, "the window moves with the clock");
	});

	it("coalesces concurrent identical requests into one HTTP call", async (t) => {
		const { api, service } = await make(t);
		api.route(MEASURE, async (_req, res) => {
			await new Promise((r) => setTimeout(r, 40));
			sendJson(res, 200, fixture("measure-optimised"));
		});
		const results = await Promise.all([1, 2, 3, 4].map(() => service.getHistory(temp24())));
		assert.ok(results.every((r) => r.kind === "ok"));
		assert.equal(api.requestsTo(MEASURE).length, 1);
	});

	it("throttles a failing combination to one real request per 30 s", async (t) => {
		const { api, clock, service } = await make(t);
		api.route(MEASURE, [(_req, res) => sendJson(res, 503, { error: { code: 1 } }), measureOk()]);
		expectError(await service.getHistory(temp24()), "transient");
		clock.nowMs += 10_000;
		expectError(await service.getHistory(temp24()), "transient");
		assert.equal(api.requestsTo(MEASURE).length, 1);
		clock.nowMs += 20_000;
		assert.equal((await service.getHistory(temp24())).kind, "ok");
		assert.equal(api.requestsTo(MEASURE).length, 2);
	});

	it("401: refreshes the token once through the shared token manager and retries with the new token", async (t) => {
		const { api, service } = await make(t);
		const refreshesBefore = api.requestsTo(TOKEN).length;
		api.route(MEASURE, [(_req, res) => sendJson(res, 401, { error: { code: 3, message: "expired" } }), measureOk()]);
		const result = await service.getHistory(temp24());
		assert.equal(result.kind, "ok");
		assert.equal(api.requestsTo(TOKEN).length, refreshesBefore + 1);
		const sent = api.requestsTo(MEASURE);
		assert.equal(sent.length, 2);
		assert.notEqual(sent[0]!.headers.authorization, sent[1]!.headers.authorization);
		assert.equal(sent[1]!.headers.authorization, `Bearer fake-access-${refreshesBefore + 1}`);
	});

	it("a second 401 after the refresh is an auth error", async (t) => {
		const { api, service } = await make(t);
		api.route(MEASURE, (_req, res) => sendJson(res, 401, { error: { code: 3 } }));
		expectError(await service.getHistory(temp24()), "auth");
		assert.equal(api.requestsTo(MEASURE).length, 2);
	});

	it("429: reason rate at once (no sleeping through Retry-After), and no repeat request while it is remembered", async (t) => {
		const { api, clock, service } = await make(t);
		api.route(MEASURE, (_req, res) => sendJson(res, 429, { error: { code: 26 } }, { "Retry-After": "120" }));
		const started = Date.now();
		expectError(await service.getHistory(temp24()), "rate");
		assert.ok(Date.now() - started < 2000);
		clock.nowMs += 60_000;
		expectError(await service.getHistory(temp24()), "rate");
		assert.equal(api.requestsTo(MEASURE).length, 1);
		clock.nowMs += 60_001;
		api.route(MEASURE, measureOk());
		assert.equal((await service.getHistory(temp24())).kind, "ok");
	});

	it("403 code 30 is an auth error, 5xx and a network failure are transient", async (t) => {
		const { api, clock, service } = await make(t);
		api.route(MEASURE, (_req, res) => sendJson(res, 403, { error: { code: 30 } }));
		expectError(await service.getHistory(temp24()), "auth");
		clock.nowMs += 31_000;
		api.route(MEASURE, (_req, res) => sendJson(res, 502, "bad gateway"));
		expectError(await service.getHistory(temp24()), "transient");
		clock.nowMs += 31_000;
		api.route(MEASURE, (_req, res) => void res.destroy());
		expectError(await service.getHistory(temp24()), "transient");
	});

	it("a response with a wrong shape is transient and its content is never echoed", async (t) => {
		const { api, service } = await make(t);
		api.route(MEASURE, (_req, res) => sendJson(res, 200, { status: "ok", body: [{ beg_time: 1_700_000_000, step_time: 1800, value: [["SECRET-VALUE"]] }] }));
		const result = expectError(await service.getHistory(temp24()), "transient");
		assert.ok(!result.message.includes("SECRET-VALUE"));
	});

	it("clearing the credentials while a request is in flight aborts it, discards the result and caches nothing", async (t) => {
		const { api, service } = await make(t);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		api.route(MEASURE, async (_req, res) => {
			await gate;
			sendJson(res, 200, fixture("measure-optimised"));
		});
		const pending = service.getHistory(temp24());
		await until(() => api.requestsTo(MEASURE).length === 1);
		await service.clearCredentials();
		release();
		const late = expectError(await pending, "transient");
		assert.match(late.message, /sign-in changed/i);

		// a new sign-in: the old result must not come back from a cache
		api.route(MEASURE, measureOk("measure-plain"));
		const again = await service.setCredentials(input);
		assert.ok(again.ok);
		const fresh = await service.getHistory(temp24());
		assert.equal(fresh.kind, "ok");
		assert.equal(api.requestsTo(MEASURE).length, 2);
	});

	it("a new sign-in drops cached history of the previous account", async (t) => {
		const { api, service } = await make(t);
		api.route(MEASURE, measureOk());
		await service.getHistory(temp24());
		const again = await service.setCredentials({ ...input, refreshToken: "pasted-refresh-0002" });
		assert.ok(again.ok);
		await service.getHistory(temp24());
		assert.equal(api.requestsTo(MEASURE).length, 2);
	});

	it("two stations: device_id follows the station, module_id only for non-base modules", async (t) => {
		const { api, service } = await make(t, "stations-two");
		api.route(MEASURE, measureOk());
		const snapshot = service.getSnapshot()!;
		assert.equal(snapshot.stations.length, 2);
		const [a, b] = snapshot.stations;
		assert.equal(a!.modules.length, 4);
		assert.equal(b!.modules.length, 1);
		const bBase = b!.modules[0]!;
		const aWind = a!.modules.find((m) => m.role === "wind")!;
		assert.equal((await service.getHistory({ stationId: b!.id, moduleId: bBase.id, metric: "co2", window: "6h" })).kind, "ok");
		assert.equal((await service.getHistory({ stationId: a!.id, moduleId: aWind.id, metric: "windStrength", window: "24h" })).kind, "ok");
		const [first, second] = api.requestsTo(MEASURE);
		assert.ok(first!.url.startsWith(`/api/getmeasure?device_id=${encodeURIComponent(b!.id)}&scale=30min&type=co2`));
		assert.ok(second!.url.startsWith(`/api/getmeasure?device_id=${encodeURIComponent(a!.id)}&module_id=${encodeURIComponent(aWind.id)}&`));
		// station B has no rain gauge; asking station A's rain id against B is unknown
		expectError(await service.getHistory({ stationId: b!.id, moduleId: aWind.id, metric: "windStrength", window: "24h" }), "unsupported");
		expectError(await service.getHistory({ stationId: b!.id, moduleId: bBase.id, metric: "rain", window: "24h" }), "unsupported");
		assert.equal(api.requestsTo(MEASURE).length, 2);
	});

	it("before the first snapshot there is nothing to ask for", async (t) => {
		const api = await startApiDouble(t);
		const service: WeatherService = createWeatherService({ baseUrl: api.baseUrl, dataDir: await makeTempDir(t), logger: new RecordingLogger() });
		t.after(() => service.dispose());
		expectError(await service.getHistory(temp24()), "transient");
		assert.equal(api.requests.length, 0);
	});
});

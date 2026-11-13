/**
 * Regression tests of review round 3 for the adapter (S1 to S13). Each test says which change
 * makes it fail when reverted. All identifiers are fictional.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { main as probeMain, ProbeStore } from "../scripts/probe-api.ts";
import { truncateForLog } from "../src/adapter/logging.ts";
import { createWeatherService } from "../src/adapter/station/create-service.ts";
import { CREDENTIALS_FILE_NAME, FileCredentialStore, type StoredCredentials } from "../src/adapter/station/credentials.ts";
import { NetatmoError, toNetatmoError } from "../src/adapter/station/errors.ts";
import { parseStationsResponse } from "../src/adapter/station/parse.ts";
import { Poller } from "../src/adapter/station/poller.ts";
import { SecretRegistry, redactSecrets, redactingLogger, variantCacheSize } from "../src/adapter/station/redact.ts";
import { ClearCredentialsError, type BrowserLoginPhase } from "../src/adapter/station/service.ts";
import { FakeClock, RecordingLogger, fixture, makeTempDir, sendJson, startApiDouble, stationsOk, tokenIssuer } from "./station-helpers.ts";

const TOKEN = "POST /oauth2/token";
const STATIONS = "GET /api/getstationsdata";
const MEASURE = "GET /api/getmeasure";
const input = { clientId: "client-id-0001", clientSecret: "client-secret-0001", refreshToken: "pasted-refresh-0001" };
const seed: StoredCredentials = { clientId: "client-id-0001", clientSecret: "client-secret-0001", refreshToken: "seed-refresh-0001" };
const canWriteProtect = process.platform !== "win32" && process.getuid?.() !== 0;

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

async function make(t: TestContext, extra: { now?: () => number; loopbackPort?: number } = {}) {
	const api = await startApiDouble(t);
	const dataDir = await makeTempDir(t);
	const logger = new RecordingLogger();
	const service = createWeatherService({ baseUrl: api.baseUrl, dataDir, logger, random: () => 0.5, ...extra });
	t.after(() => service.dispose());
	return { api, dataDir, logger, service, file: new FileCredentialStore({ dataDir, logger: new RecordingLogger() }) };
}

function get(port: number, urlPath: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: urlPath, agent: false }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end();
	});
}

// ---------------------------------------------------------------------------------------
// S9: redaction registry, C1 controls
// ---------------------------------------------------------------------------------------

describe("S9: the secret registry keeps two generations and the variant cache is bounded", () => {
	// Without the eviction in add(), the first generation is still masked (and still costs time on every line).
	it("masks the current and the previous generation, forgets older ones", () => {
		const reg = new SecretRegistry();
		reg.add(["gen-one-secret", "gen-one-token-AAAA"]);
		reg.add(["gen-two-secret", "gen-two-token-BBBB"]);
		reg.add(["gen-three-secret", "gen-three-token-CCCC"]);
		const masked = redactSecrets("a gen-one-secret b gen-two-secret c gen-three-secret", reg.values());
		assert.equal(masked, "a gen-one-secret b *** c ***");
		assert.equal(reg.values().length, 4);
	});

	it("the same values again do not start a new generation (every load re-tracks them)", () => {
		const reg = new SecretRegistry();
		reg.add(["first-secret", "first-token-0001"]);
		reg.add(["second-secret", "second-token-0001"]);
		for (let i = 0; i < 10; i++) reg.add(["second-secret", "second-token-0001"]);
		assert.ok(reg.values().includes("first-secret"), "the previous generation was not pushed out by repeats");
	});

	it("ignores empty and undefined values", () => {
		const reg = new SecretRegistry();
		reg.add(["", undefined]);
		assert.deepEqual(reg.values(), []);
	});

	// Without the size limit in variants(), one entry per secret ever seen stays in memory.
	it("the variant cache does not grow with the number of secrets", () => {
		for (let i = 0; i < 200; i++) redactSecrets("x", [`rotating-secret-value-${i}`]);
		assert.ok(variantCacheSize() <= 32, `cache holds ${variantCacheSize()}`);
		assert.equal(redactSecrets("rotating-secret-value-199 and rotating-secret-value-0", ["rotating-secret-value-199", "rotating-secret-value-0"]), "*** and ***");
	});
});

describe("S9: truncateForLog escapes C1 controls", () => {
	// Without the 0x80..0x9f range, U+009B (CSI) reaches the log file as a one-character escape introducer.
	it("U+009B and the rest of 0x80..0x9f become \\x escapes; U+00A0 and text stay", () => {
		assert.equal(truncateForLog("a\u009b31mb\u0080\u009f é"), "a\\x9b31mb\\x80\\x9f é");
		assert.equal(truncateForLog("tab\there\u007f"), "tab\\x09here\\x7f");
	});
});

// ---------------------------------------------------------------------------------------
// T1: the service's redacting logger, all four levels
// ---------------------------------------------------------------------------------------

describe("T1: nothing the service logs contains a secret", () => {
	it("redactingLogger masks at debug, info, warn and error", () => {
		const rec = new RecordingLogger();
		const log = redactingLogger(rec, () => ["distinctive-secret-0001"]);
		log.debug("d distinctive-secret-0001");
		log.info("i distinctive-secret-0001");
		log.warn("w distinctive-secret-0001");
		log.error("e distinctive-secret-0001");
		assert.deepEqual(rec.lines, ["DEBUG d ***", "INFO i ***", "WARN w ***", "ERROR e ***"]);
	});

	/** A fetch whose response throws a foreign error from inside the adapter, with the request body (secrets!) in the message. */
	const echoingFetch = (): typeof fetch =>
		(async (_url: string, init?: { body?: string }) => ({
			status: 200,
			body: null,
			headers: {
				get: () => {
					throw new Error(`proxy echo: ${String(init?.body)}`);
				},
			},
		})) as unknown as typeof fetch;

	it("setCredentials with a double that echoes the pasted secrets", async (t) => {
		const logger = new RecordingLogger();
		const service = createWeatherService({ fetchImpl: echoingFetch(), baseUrl: "http://127.0.0.1:9", dataDir: await makeTempDir(t), logger });
		t.after(() => service.dispose());
		const result = await service.setCredentials(input);
		assert.equal(result.ok, false);
		const text = logger.text();
		// the scan must be able to see something: the foreign error WAS logged, with its message
		assert.match(text, /ERROR service: unexpected error: Error: proxy echo: /);
		for (const secret of [input.clientSecret, input.refreshToken]) assert.ok(!text.includes(secret), `leaked ${secret}`);
		assert.ok(!(result.ok === false && (result.error.includes(input.refreshToken) || result.error.includes(input.clientSecret))));
	});

	it("startBrowserLogin with a double that echoes the client secret and the code", async (t) => {
		const logger = new RecordingLogger();
		const opened: string[] = [];
		const phases: BrowserLoginPhase[] = [];
		const service = createWeatherService({ fetchImpl: echoingFetch(), baseUrl: "http://127.0.0.1:9", dataDir: await makeTempDir(t), logger, loopbackPort: 0 });
		t.after(() => service.dispose());
		const run = service.startBrowserLogin({ clientId: input.clientId, clientSecret: input.clientSecret }, async (url) => void opened.push(url), (p) => void phases.push(p));
		await until(() => opened.length === 1, "the browser to open");
		const waiting = phases.find((p) => p.phase === "waiting");
		assert.ok(waiting && waiting.phase === "waiting");
		const state = new URL(opened[0]!).searchParams.get("state")!;
		const port = Number(new URL(waiting.redirectUri).port);
		await get(port, `/callback?code=auth-code-distinctive&state=${encodeURIComponent(state)}`);
		await run;
		const text = logger.text();
		assert.match(text, /ERROR login: unexpected error during the code exchange: Error: proxy echo: /);
		assert.ok(!text.includes(input.clientSecret), "client secret leaked");
		assert.ok(!text.includes("auth-code-distinctive"), "authorization code leaked");
	});
});

// ---------------------------------------------------------------------------------------
// S2 / S6 / S10 / S12 / S1: the service
// ---------------------------------------------------------------------------------------

describe("S2: a failed write after a successful sign-in keeps the rotated pair alive", { skip: !canWriteProtect }, () => {
	// Without tokens.adoptUnpersisted() the rotated pair is dropped by resetTokens(): the poller finds nothing and the plugin is signed out.
	it("logs the errno, adopts the pair in memory, flags the warning and retries the write on the next poll", async (t) => {
		let now = 1_700_000_100_000;
		const { api, dataDir, logger, service, file } = await make(t, { now: () => now });
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		await fs.chmod(dataDir, 0o500);
		try {
			const result = await service.setCredentials(input);
			assert.equal(result.ok, false);
			assert.ok(!result.ok && result.saved === false);
			assert.ok(!result.ok && /could not be saved \(EACCES: the folder is not writable\)/.test(result.error), JSON.stringify(result));
			assert.ok(!result.ok && result.error.includes(dataDir), "names the folder");
			assert.match(logger.text(), /ERROR service: could not persist credentials after sign-in \(EACCES\)/);
			assert.ok(service.getSnapshot(), "the validated snapshot is shown");
			assert.deepEqual(service.getConnectionState(), { kind: "ok", warning: "unpersisted-rotation" });
		} finally {
			await fs.chmod(dataDir, 0o700);
		}
		assert.equal(await file.load(), undefined);
		// the next poll uses the adopted pair (no refresh needed yet) and writes it
		now += 120_000;
		await service.refresh();
		assert.equal((await file.load())?.refreshToken, "fake-refresh-1");
		assert.deepEqual(service.getConnectionState(), { kind: "ok" });
		assert.equal(api.requestsTo(TOKEN).length, 1, "the adopted access token was still valid: no second refresh");
	});
});

describe("S6: an auth failure after the refresh is not promised a retry", () => {
	// Before: "Polling will retry." although the poller stops on the same error.
	it("403 code 13 (missing read_station): saved, scope text, no retry promise, poller stopped", async (t) => {
		const { api, service, file } = await make(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, (_req, res) => sendJson(res, 403, { error: { code: 13, message: "Access forbidden" } }));
		const result = await service.setCredentials(input);
		assert.ok(!result.ok && result.saved === true);
		assert.equal(!result.ok && result.error, "Saved, but Netatmo does not allow reading station data with this token (missing read_station scope?). Create the token again with only read_station.");
		assert.equal((await file.load())?.refreshToken, "fake-refresh-1", "the rotated token is saved");
		assert.equal(service.getConnectionState().kind === "auth-error" || service.getConnectionState().kind === "loading", true);
	});

	it("another auth code quotes our own message instead; a 5xx still says polling retries", async (t) => {
		const { api, service } = await make(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, (_req, res) => sendJson(res, 406, { error: { code: 5, message: "x" } }));
		const deactivated = await service.setCredentials(input);
		assert.ok(!deactivated.ok && deactivated.saved === true && /^Saved, but Netatmo rejected the station request: The Netatmo app has been deactivated/.test(deactivated.error));
		assert.ok(!deactivated.ok && !/retry/i.test(deactivated.error));
		api.route(STATIONS, (_req, res) => sendJson(res, 500, { error: { code: 2 } }));
		const transient = await service.setCredentials(input);
		assert.ok(!transient.ok && transient.saved === true && /Polling will retry\.$/.test(transient.error));
	});
});

describe("S10: one validation, also before the browser opens", () => {
	// Without parseLoginInput() in the service, the browser opens and a bad id is only found after the single-use code was spent.
	it("startBrowserLogin refuses a bad client ID or secret before any browser or listener", async (t) => {
		const { service } = await make(t, { loopbackPort: 0 });
		for (const [bad, expected] of [
			[{ clientId: "has space", clientSecret: "ok-secret-0001" }, /client ID contains spaces/],
			[{ clientId: "ok-id-0001", clientSecret: "s".repeat(513) }, /client secret is too long/],
			[{ clientId: "", clientSecret: "ok-secret-0001" }, /client ID is required/],
		] as const) {
			const phases: BrowserLoginPhase[] = [];
			const opened: string[] = [];
			await service.startBrowserLogin(bad, async (u) => void opened.push(u), (p) => void phases.push(p));
			assert.equal(opened.length, 0, "no browser");
			assert.equal(phases.length, 1);
			assert.ok(phases[0]?.phase === "error" && expected.test(phases[0].message), JSON.stringify(phases));
		}
	});

	it("setCredentials says `too long` for a long paste, not `required`, and sends no request", async (t) => {
		const { api, service } = await make(t);
		const result = await service.setCredentials({ ...input, refreshToken: "t".repeat(513) });
		assert.ok(!result.ok && /refresh token is too long \(at most 512 characters\)/.test(result.error));
		assert.equal(api.requests.length, 0);
	});
});

describe("S12: the credential summary tells a damaged file from a missing one", () => {
	it("missing -> plain not configured; damaged -> unreadable", async (t) => {
		const { service, dataDir } = await make(t);
		assert.deepEqual(await service.getCredentialSummary(), { configured: false });
		await fs.writeFile(path.join(dataDir, CREDENTIALS_FILE_NAME), "{this is damaged");
		assert.deepEqual(await service.getCredentialSummary(), { configured: false, unreadable: true });
	});

	it("exposes where the file is", async (t) => {
		const { service, dataDir } = await make(t);
		assert.equal(service.credentialsLocation, path.join(dataDir, CREDENTIALS_FILE_NAME));
	});
});

describe("S1: clearCredentials rejects when the file cannot be removed", { skip: !canWriteProtect }, () => {
	// Before: the raw fs error escaped, so the router could only log its name; and without the rejection the PI said "removed".
	it("rejects with ClearCredentialsError (errno, path), keeps the file and keeps polling", async (t) => {
		const { api, dataDir, service, file } = await make(t);
		await file.save(seed);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		const sub = service.subscribe(() => undefined);
		t.after(() => sub.unsubscribe());
		await until(() => service.getSnapshot() !== undefined, "first snapshot");
		await fs.chmod(dataDir, 0o500);
		try {
			await assert.rejects(service.clearCredentials(), (error: unknown) => {
				assert.ok(error instanceof ClearCredentialsError);
				assert.equal(error.code, "EACCES");
				assert.equal(error.path, path.join(dataDir, CREDENTIALS_FILE_NAME));
				assert.match(error.message, /could not be removed \(EACCES\)\. Polling continues with them\. Delete the file .* by hand/);
				return true;
			});
		} finally {
			await fs.chmod(dataDir, 0o700);
		}
		assert.ok(await file.load(), "the file is still there");
		assert.ok(service.getSnapshot(), "polling state untouched");
		assert.equal(service.getConnectionState().kind, "ok");
	});

	it("a clear that works stops polling and drops the snapshot", async (t) => {
		const { api, service, file } = await make(t);
		await file.save(seed);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		const sub = service.subscribe(() => undefined);
		t.after(() => sub.unsubscribe());
		await until(() => service.getSnapshot() !== undefined, "first snapshot");
		await service.clearCredentials();
		assert.equal(await file.load(), undefined);
		assert.equal(service.getSnapshot(), undefined);
		assert.equal(service.getConnectionState().kind, "no-credentials");
	});
});

// ---------------------------------------------------------------------------------------
// T2: browser login through the service
// ---------------------------------------------------------------------------------------

describe("T2: startBrowserLogin through the service", () => {
	async function start(service: ReturnType<typeof createWeatherService>) {
		const opened: string[] = [];
		const phases: BrowserLoginPhase[] = [];
		const done = service.startBrowserLogin({ clientId: input.clientId, clientSecret: input.clientSecret }, async (u) => void opened.push(u), (p) => void phases.push(p));
		await until(() => phases.some((p) => p.phase === "waiting"), "waiting phase");
		const waiting = phases.find((p) => p.phase === "waiting");
		const port = waiting && waiting.phase === "waiting" ? Number(new URL(waiting.redirectUri).port) : 0;
		return { opened, phases, done, port, state: () => new URL(opened[0]!).searchParams.get("state")! };
	}

	// Without `login?.cancel(...)` the first flow stays open next to the second.
	it("a second attempt replaces the first: the first ends with the replaced message, the second waits", async (t) => {
		const { api, service } = await make(t, { loopbackPort: 0 });
		api.route(TOKEN, tokenIssuer("login"));
		const first = await start(service);
		const second = await start(service);
		await first.done;
		assert.deepEqual(first.phases.at(-1), { phase: "error", message: "Replaced by a newer sign-in attempt." });
		assert.deepEqual(second.phases.map((p) => p.phase), ["waiting"]);
		assert.notEqual(first.port, second.port);
		await assert.rejects(get(first.port, "/callback"), "the first listener is closed");
		assert.equal(await get(second.port, "/other"), 404, "the second one is alive");
		service.dispose();
		await second.done;
	});

	// Without resetTokens() in the store wrapper / onSuccess, the token manager keeps the OLD cached pair and the next refresh sends the old refresh token.
	it("after a successful login the next refresh sends the NEW refresh token", async (t) => {
		let now = 1_700_000_100_000;
		const { api, service, file } = await make(t, { loopbackPort: 0, now: () => now });
		await file.save(seed);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		const sub = service.subscribe(() => undefined);
		t.after(() => sub.unsubscribe());
		await until(() => service.getSnapshot() !== undefined, "first snapshot");
		assert.equal(api.requestsTo(TOKEN).length, 1, "poll refresh with the seed token");
		const flowRun = await start(service);
		assert.equal(await get(flowRun.port, `/callback?code=the-code&state=${encodeURIComponent(flowRun.state())}`), 200);
		await flowRun.done;
		assert.equal(flowRun.phases.at(-1)?.phase, "done");
		assert.equal((await file.load())?.refreshToken, "fake-refresh-2", "the exchange grant is on disk");
		now += 4 * 3600_000; // access token expired
		await service.refresh();
		const last = api.requestsTo(TOKEN).at(-1)!;
		assert.equal(new URLSearchParams(last.body).get("grant_type"), "refresh_token");
		assert.equal(new URLSearchParams(last.body).get("refresh_token"), "fake-refresh-2");
	});

	it("a write failure after the exchange keeps the grant in memory and warns", { skip: !canWriteProtect }, async (t) => {
		const { api, dataDir, service, logger } = await make(t, { loopbackPort: 0 });
		api.route(TOKEN, tokenIssuer("login"));
		api.route(STATIONS, stationsOk());
		const sub = service.subscribe(() => undefined); // a poller without a subscriber does not poll
		t.after(() => sub.unsubscribe());
		await fs.chmod(dataDir, 0o500);
		try {
			const flowRun = await start(service);
			await get(flowRun.port, `/callback?code=the-code&state=${encodeURIComponent(flowRun.state())}`);
			await flowRun.done;
			const last = flowRun.phases.at(-1)!;
			assert.ok(last.phase === "error" && /could not be saved to disk \(EACCES\)/.test(last.message));
			assert.match(logger.text(), /ERROR login: could not save the credentials after sign-in \(EACCES\)/);
			await until(() => service.getSnapshot() !== undefined, "snapshot from the in-memory grant");
			assert.deepEqual(service.getConnectionState(), { kind: "ok", warning: "unpersisted-rotation" });
		} finally {
			await fs.chmod(dataDir, 0o700);
		}
	});
});

// ---------------------------------------------------------------------------------------
// S4: failures leave a trace
// ---------------------------------------------------------------------------------------

describe("S4: failures are logged with their cause", () => {
	it("toNetatmoError logs a foreign error (name, message, code, frames) and stays generic for the caller", () => {
		const log = new RecordingLogger();
		const error = Object.assign(new TypeError("boom 42"), { code: "ERR_X" });
		const converted = toNetatmoError(error, log);
		assert.equal(converted.message, "Unexpected internal error");
		assert.match(log.text(), /^ERROR unexpected error: TypeError: boom 42 \(code ERR_X\) @ at /);
		const quiet = new RecordingLogger();
		toNetatmoError(new NetatmoError("auth", "x"), quiet);
		assert.deepEqual(quiet.lines, [], "a NetatmoError is already described: no extra line");
	});

	// Before: "poll failed (transient); attempt 1": status and code were lost.
	it("the poll-failure line carries kind, HTTP status and code", async () => {
		const clock = new FakeClock();
		const logger = new RecordingLogger();
		const poller = new Poller({
			fetchSnapshot: () => Promise.reject(new NetatmoError("transient", "unavailable", { status: 502, code: "2" })),
			hasCredentials: async () => true,
			now: clock.now,
			random: () => 0.5,
			timers: clock.timersApi,
			logger,
		});
		poller.subscribe(() => undefined);
		await poller.whenIdle();
		assert.match(logger.text(), /WARN poll failed \(transient HTTP 502 code 2\); attempt 1/);
		poller.dispose();
	});

	// Before: debug only, and the default level is info.
	it("a getmeasure answer the parser rejects is logged at warn, with the reason", async (t) => {
		const { api, service, logger } = await make(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		const set = await service.setCredentials(input);
		assert.ok(set.ok);
		const snapshot = service.getSnapshot()!;
		const station = snapshot.stations[0]!;
		api.route(MEASURE, (_req, res) => sendJson(res, 200, { status: "ok", body: "not what we expect" }));
		const result = await service.getHistory({ stationId: station.id, moduleId: station.modules[0]!.id, metric: "temperature", window: "24h" });
		assert.equal(result.kind, "error");
		assert.match(logger.text(), /WARN history: history temperature 24h failed \(protocol HTTP 200\): /);
	});
});

// ---------------------------------------------------------------------------------------
// S11: parse
// ---------------------------------------------------------------------------------------

describe("S11: an unrecognisable station list is an error, not `0 stations`", () => {
	const body = (extra: Record<string, unknown>) => ({ status: "ok", body: { user: { administrative: {} }, ...extra } });

	// Before: a renamed `devices` array parsed to "ok, 0 stations" without a word.
	it("a missing devices array in a non-empty body throws a protocol error and warns", () => {
		const warnings: string[] = [];
		assert.throws(
			() => parseStationsResponse(body({}), 1, { warn: (m) => warnings.push(m) }),
			(e: unknown) => e instanceof NetatmoError && e.kind === "protocol",
		);
		assert.deepEqual(warnings, ["the response body has no `devices` array"]);
	});

	it("devices of which none can be understood is a protocol error; a genuinely empty account is fine", () => {
		assert.throws(() => parseStationsResponse(body({ devices: [{ type: "NAPlug" }, 7] }), 1), (e: unknown) => e instanceof NetatmoError && e.kind === "protocol");
		const empty = parseStationsResponse(fixture("stations-empty"), 1);
		assert.deepEqual(empty.stations, []);
		assert.equal(parseStationsResponse(body({ devices: [] }), 1).stations.length, 0);
	});

	// The module key is "<station>|<module>": an id with a pipe could not be told apart.
	it("ids containing `|` are refused (module dropped, station dropped)", () => {
		const raw = fixture("stations-full");
		raw.body.devices[0].modules[0]._id = "00:00:5e:00:53:aa|00:00:5e:00:53:bb";
		const parsed = parseStationsResponse(raw, 1);
		assert.ok(parsed.stations[0]!.modules.every((m) => !m.id.includes("|")));
		assert.equal(parsed.stations[0]!.modules.length, raw.body.devices[0].modules.length, "one module fewer than before (base + the rest minus the bad one)");
		const bad = fixture("stations-full");
		bad.body.devices[0]._id = "00:00:5e:00:53:aa|x";
		assert.throws(() => parseStationsResponse(bad, 1), (e: unknown) => e instanceof NetatmoError, "the only station was dropped");
	});
});

// ---------------------------------------------------------------------------------------
// S13: the probe
// ---------------------------------------------------------------------------------------

describe("S13: the probe fails loudly when the rotated refresh token is stored nowhere", () => {
	const env = { NETATMO_CLIENT_ID: "id-0001", NETATMO_CLIENT_SECRET: "secret-0001", NETATMO_REFRESH_TOKEN: "seed-refresh-0001" };
	const creds = { clientId: "id-0001", clientSecret: "secret-0001", refreshToken: "old" };

	it("ProbeStore.save rejects, leaves no directory behind and flags persistFailed", async (t) => {
		const root = await makeTempDir(t);
		const missing = path.join(root, "does-not-exist");
		const store = new ProbeStore(creds, () => ({ ok: false }), missing);
		await assert.rejects(store.save({ ...creds, refreshToken: "new-token-xyz" }), (e: unknown) => e instanceof Error && /could not store the rotated refresh token \(ENOENT\)/.test(e.message) && !e.message.includes("new-token-xyz"));
		assert.equal(store.persistFailed, true);
		assert.equal(store.report, undefined);
		// a later success clears the flag
		const ok = new ProbeStore(creds, () => ({ ok: true }));
		await ok.save({ ...creds, refreshToken: "n" });
		assert.equal(ok.persistFailed, false);
	});

	it("main exits non-zero and says the old token is invalid; the token is never printed", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		api.route("POST /api/getstationsdata", stationsOk());
		const root = await makeTempDir(t);
		const err: string[] = [];
		const out: string[] = [];
		const origErr = console.error;
		const origLog = console.log;
		console.error = (...a: unknown[]) => void err.push(a.join(" "));
		console.log = (...a: unknown[]) => void out.push(a.join(" "));
		let code: number;
		try {
			code = await probeMain([], env, { baseUrl: api.baseUrl, runSecretspec: () => ({ ok: false }), tempRoot: path.join(root, "missing") });
		} finally {
			console.error = origErr;
			console.log = origLog;
		}
		assert.equal(code, 1);
		assert.match(err.join("\n"), /rotated refresh token could NOT be stored/);
		assert.match(err.join("\n"), /old one is invalid/);
		assert.ok(!(err.join("\n") + out.join("\n")).includes("fake-refresh-1"));
	});
});

/**
 * Regression tests for the security review of the station adapter. Each test names the
 * behaviour it pins; the comment says which deletion of which line makes it fail (checked by
 * reverting that line, see the review notes).
 *
 * All identifiers are fictional (fake tokens, loopback doubles).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, it, type TestContext } from "node:test";
import { startBrowserLogin } from "../src/adapter/station/browser-login.ts";
import { createWeatherService, TrackingStore } from "../src/adapter/station/create-service.ts";
import { FileCredentialStore, MemoryCredentialStore, type CredentialStore, type StoredCredentials } from "../src/adapter/station/credentials.ts";
import { NetatmoClient } from "../src/adapter/station/client.ts";
import { NetatmoError } from "../src/adapter/station/errors.ts";
import { USAGE_LIMIT_PAUSE_MS } from "../src/adapter/station/oauth.ts";
import { Poller } from "../src/adapter/station/poller.ts";
import { SecretRegistry, redactSecrets } from "../src/adapter/station/redact.ts";
import { TokenManager } from "../src/adapter/station/token-manager.ts";
import {
	FakeClock,
	type Handler,
	RecordingLogger,
	makeTempDir,
	sendJson,
	startApiDouble,
	stationsOk,
	tokenIssuer,
} from "./station-helpers.ts";

const TOKEN = "POST /oauth2/token";
const STATIONS = "GET /api/getstationsdata";
const seed: StoredCredentials = { clientId: "client-id-0001", clientSecret: "client-secret-0001", refreshToken: "seed-refresh-0001" };

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** A handler that holds the response until `release()` is called; `aborted` flips when the client hangs up first. */
function gated(answer: Handler): { handler: Handler; release: () => void; state: { aborted: boolean; arrived: boolean } } {
	let release: () => void = () => undefined;
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	const state = { aborted: false, arrived: false };
	const handler: Handler = async (req, res) => {
		state.arrived = true;
		res.on("close", () => {
			if (!res.writableEnded) state.aborted = true;
		});
		await open;
		if (state.aborted) return;
		await answer(req, res);
	};
	return { handler, release, state };
}

const issue = (access: string, refresh: string): Handler => (_req, res) => sendJson(res, 200, { access_token: access, refresh_token: refresh, expires_in: 10800 });

// ---------------------------------------------------------------------------------------
// security F1: an in-flight refresh must not outlive Clear / a new sign-in
// ---------------------------------------------------------------------------------------

describe("F1: a refresh in flight when credentials are cleared or replaced is discarded", () => {
	// Without the generation check in TokenManager.doRefresh/persist the old refresh result is written
	// to the store after the clear (file reappears) or over the new credentials.
	it("Clear: the file stays deleted and nothing is cached (TokenManager + real FileCredentialStore)", async (t) => {
		const dir = await makeTempDir(t);
		const store = new FileCredentialStore({ dataDir: dir, logger: new RecordingLogger() });
		await store.save(seed);
		const api = await startApiDouble(t);
		const gate = gated(issue("old-access-1", "old-refresh-rotated-1"));
		api.route(TOKEN, gate.handler);
		const tokens = new TokenManager({ store, baseUrl: api.baseUrl, logger: new RecordingLogger() });
		const pending = tokens.getAccessToken();
		pending.catch(() => undefined);
		await until(() => gate.state.arrived, "refresh request");
		await store.clear();
		tokens.reset();
		gate.release();
		await assert.rejects(pending, (e: unknown) => e instanceof NetatmoError);
		assert.equal(await store.load(), undefined, "the cleared credentials must not come back");
		assert.equal(await tokens.hasCredentials(), false, "and the manager must not cache the old pair");
	});

	it("new sign-in: the disk keeps the NEW pair and the next refresh uses it", async (t) => {
		const dir = await makeTempDir(t);
		const store = new FileCredentialStore({ dataDir: dir, logger: new RecordingLogger() });
		await store.save(seed);
		const api = await startApiDouble(t);
		const gate = gated(issue("old-access-1", "old-refresh-rotated-1"));
		api.route(TOKEN, [gate.handler, issue("new-access-2", "new-refresh-rotated-2")]);
		const tokens = new TokenManager({ store, baseUrl: api.baseUrl, logger: new RecordingLogger() });
		const pending = tokens.getAccessToken();
		pending.catch(() => undefined);
		await until(() => gate.state.arrived, "refresh request");
		await store.save({ clientId: "client-id-0002", clientSecret: "client-secret-0002", refreshToken: "brand-new-refresh-0002" });
		tokens.reset();
		gate.release();
		await assert.rejects(pending, (e: unknown) => e instanceof NetatmoError);
		assert.equal((await store.load())?.refreshToken, "brand-new-refresh-0002");
		assert.equal(await tokens.getAccessToken(), "new-access-2");
		assert.equal(new URLSearchParams(api.requestsTo(TOKEN)[1]!.body).get("refresh_token"), "brand-new-refresh-0002");
	});

	it("service: clearCredentials during a background refresh leaves no credentials file", async (t) => {
		const api = await startApiDouble(t);
		const dataDir = await makeTempDir(t);
		const file = new FileCredentialStore({ dataDir, logger: new RecordingLogger() });
		await file.save(seed);
		const gate = gated(issue("old-access-1", "old-refresh-rotated-1"));
		api.route(TOKEN, gate.handler);
		api.route(STATIONS, stationsOk());
		const service = createWeatherService({ baseUrl: api.baseUrl, dataDir, logger: new RecordingLogger(), random: () => 0.5 });
		t.after(() => service.dispose());
		const sub = service.subscribe(() => undefined);
		t.after(() => sub.unsubscribe());
		await until(() => gate.state.arrived, "poller refresh");
		await service.clearCredentials();
		gate.release();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(await file.load(), undefined);
		assert.deepEqual(await service.getCredentialSummary(), { configured: false });
	});

	it("service: setCredentials during a background refresh keeps the new pair on disk", async (t) => {
		const api = await startApiDouble(t);
		const dataDir = await makeTempDir(t);
		const file = new FileCredentialStore({ dataDir, logger: new RecordingLogger() });
		await file.save(seed);
		const gate = gated(issue("old-access-1", "old-refresh-rotated-1"));
		api.route(TOKEN, [gate.handler, issue("new-access-2", "new-refresh-rotated-2")]);
		api.route(STATIONS, stationsOk());
		const service = createWeatherService({ baseUrl: api.baseUrl, dataDir, logger: new RecordingLogger(), random: () => 0.5 });
		t.after(() => service.dispose());
		const sub = service.subscribe(() => undefined);
		t.after(() => sub.unsubscribe());
		await until(() => gate.state.arrived, "poller refresh");
		const result = await service.setCredentials({ clientId: "client-id-0002", clientSecret: "client-secret-0002", refreshToken: "pasted-refresh-0002" });
		assert.ok(result.ok);
		gate.release();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal((await file.load())?.refreshToken, "new-refresh-rotated-2");
	});
});

// ---------------------------------------------------------------------------------------
// security F2: a rotated pair that could not be written is surfaced, not just logged
// ---------------------------------------------------------------------------------------

describe("F2: unpersisted rotation becomes a warning on the ok state", () => {
	class FlakyStore implements CredentialStore {
		failSaves = true;
		value: StoredCredentials | undefined = seed;
		async load() {
			return this.value;
		}
		async save(c: StoredCredentials) {
			if (this.failSaves) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			this.value = c;
		}
		async clear() {
			this.value = undefined;
		}
	}

	// Without the `warning` option (or without create-service wiring it to hasUnpersistedRotation) the state stays "ok".
	it("poll succeeds with data, state is ok WITH the warning (never `error`), and loses the warning once the write works", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		const clock = new FakeClock();
		const store = new FlakyStore();
		const logger = new RecordingLogger();
		const tokens = new TokenManager({ store, baseUrl: api.baseUrl, logger, now: clock.now });
		const client = new NetatmoClient({ tokens, baseUrl: api.baseUrl, logger, now: clock.now });
		const poller = new Poller({
			fetchSnapshot: () => client.fetchSnapshot(),
			hasCredentials: () => tokens.hasCredentials(),
			warning: () => (tokens.hasUnpersistedRotation ? "unpersisted-rotation" : undefined),
			now: clock.now,
			random: () => 0.5,
			timers: clock.timersApi,
			logger,
		});
		const sub = poller.subscribe(() => undefined);
		t.after(() => sub.unsubscribe());
		await until(() => poller.getSnapshot() !== undefined, "first snapshot");
		const state = poller.getConnectionState();
		assert.deepEqual(state, { kind: "ok", warning: "unpersisted-rotation" });
		assert.equal(tokens.hasUnpersistedRotation, true);
		assert.match(logger.text(), /could not persist credentials/);
		assert.ok(!logger.text().includes("fake-refresh-1"), "never a token value in the log line");

		store.failSaves = false;
		await clock.advance(301_000); // one poll interval (jitter fixed at 0)
		await until(() => {
			const s = poller.getConnectionState();
			return s.kind === "ok" && s.warning === undefined;
		}, "warning gone");
		assert.deepEqual(poller.getConnectionState(), { kind: "ok" });
		assert.equal(tokens.hasUnpersistedRotation, false);
		assert.equal(store.value?.refreshToken, "fake-refresh-1", "the retry wrote the rotated pair");
		poller.dispose();
	});
});

describe("F2: the service wires the warning (read-only data directory)", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
	// Without the `warning` wiring in create-service.ts the state stays "ok" and the user is told nothing.
	it("a refresh whose result cannot be written shows the warning while data keeps flowing", async (t) => {
		const api = await startApiDouble(t);
		const dataDir = await makeTempDir(t);
		await new FileCredentialStore({ dataDir, logger: new RecordingLogger() }).save(seed);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		await fs.chmod(dataDir, 0o500); // loadable, but no new file can be created in it
		const service = createWeatherService({ baseUrl: api.baseUrl, dataDir, logger: new RecordingLogger(), random: () => 0.5 });
		try {
			const sub = service.subscribe(() => undefined);
			await until(() => service.getSnapshot() !== undefined, "snapshot");
			const state = service.getConnectionState();
			assert.deepEqual(state, { kind: "ok", warning: "unpersisted-rotation" });
			sub.unsubscribe();
		} finally {
			service.dispose();
			await fs.chmod(dataDir, 0o700);
		}
	});
});

// ---------------------------------------------------------------------------------------
// security F3: cancel aborts the exchange and never saves
// ---------------------------------------------------------------------------------------

describe("F3: browser sign-in cancelled during the code exchange", () => {
	// Without the abort signal the token request keeps running; without the `ended` check the credentials are saved
	// and onSuccess runs after the PI saw the error (the second test hides the abort from the check on purpose).
	for (const honourAbort of [true, false]) {
	it(`${honourAbort ? "aborts the request, " : "even when the transport ignores the abort, "}saves nothing, does not run onSuccess`, async (t: TestContext) => {
		const api = await startApiDouble(t);
		const gate = gated(tokenIssuer("login"));
		api.route(TOKEN, gate.handler);
		const store = new FileCredentialStore({ dataDir: await makeTempDir(t), logger: new RecordingLogger() });
		const phases: string[] = [];
		const opened: string[] = [];
		let succeeded = false;
		let redirect = "";
		const handle = startBrowserLogin({
			clientId: "client-id-0001",
			clientSecret: "client-secret-0001",
			port: 0,
			store,
			baseUrl: api.baseUrl,
			logger: new RecordingLogger(),
			fetchImpl: honourAbort ? undefined : (url, init) => fetch(url, { ...init, signal: undefined }),
			openUrl: async (url) => void opened.push(url),
			onPhase: (p) => {
				phases.push(p.phase === "error" ? `error:${p.message}` : p.phase);
				if (p.phase === "waiting") redirect = p.redirectUri;
			},
			onSuccess: () => void (succeeded = true),
		});
		t.after(() => handle.cancel());
		await until(() => redirect !== "" && opened.length === 1, "listener");
		const state = new URL(opened[0]!).searchParams.get("state")!;
		const res = await fetch(`${redirect.replace("localhost", "127.0.0.1")}?code=abc-code-0001&state=${encodeURIComponent(state)}`);
		assert.equal(res.status, 200);
		await until(() => gate.state.arrived, "token request");
		handle.cancel("Replaced by a newer sign-in attempt.");
		await handle.finished;
		if (honourAbort) await until(() => gate.state.aborted, "the token request is aborted");
		gate.release();
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(await store.load(), undefined);
		assert.equal(succeeded, false);
		assert.deepEqual(phases, ["waiting", "error:Replaced by a newer sign-in attempt."]);
	});
	}
});

// ---------------------------------------------------------------------------------------
// security F4: redirects must reach a recording second double with ZERO requests
// ---------------------------------------------------------------------------------------

describe("F4: redirects are not followed (a second server records what would arrive)", () => {
	// With `redirect: "follow"` in http.ts the second double receives the request (and the bearer token).
	it("data endpoint: the redirect target sees no request and no Authorization header", async (t) => {
		const target = await startApiDouble(t);
		target.route("GET /elsewhere", (_req, res) => sendJson(res, 200, { status: "ok", body: { devices: [] } }));
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, (_req, res) => {
			res.writeHead(302, { Location: `${target.baseUrl}/elsewhere` });
			res.end();
		});
		const store = new MemoryCredentialStore({ ...seed, accessToken: "stored-access-0001", accessTokenExpiresAt: Date.now() + 3_600_000 });
		const tokens = new TokenManager({ store, baseUrl: api.baseUrl, logger: new RecordingLogger() });
		const client = new NetatmoClient({ tokens, baseUrl: api.baseUrl, logger: new RecordingLogger() });
		await assert.rejects(client.fetchSnapshot(), (e: unknown) => e instanceof NetatmoError && e.kind === "transient");
		assert.equal(api.requestsTo(STATIONS).length, 1, "the original request was made");
		assert.equal(target.requests.length, 0, "nothing reached the redirect target");
		assert.ok(target.requests.every((r) => r.headers.authorization === undefined));
	});

	it("token endpoint: the POST body (client secret, refresh token) never reaches the redirect target", async (t) => {
		const target = await startApiDouble(t);
		target.route("POST /elsewhere", (_req, res) => sendJson(res, 200, {}));
		target.route("GET /elsewhere", (_req, res) => sendJson(res, 200, {}));
		const api = await startApiDouble(t);
		api.route(TOKEN, (_req, res) => {
			res.writeHead(307, { Location: `${target.baseUrl}/elsewhere` });
			res.end();
		});
		const tokens = new TokenManager({ store: new MemoryCredentialStore(seed), baseUrl: api.baseUrl, logger: new RecordingLogger() });
		await assert.rejects(tokens.getAccessToken(), (e: unknown) => e instanceof NetatmoError && e.kind === "transient");
		assert.equal(api.requestsTo(TOKEN).length, 1);
		assert.equal(target.requests.length, 0);
		assert.ok(!target.requests.some((r) => r.body.includes(seed.clientSecret)));
	});
});

// ---------------------------------------------------------------------------------------
// security F5: behaviours that survived deletion
// ---------------------------------------------------------------------------------------

describe("F5: TrackingStore feeds every credential value to the redactor", () => {
	const creds: StoredCredentials = { clientId: "client-id-0001", clientSecret: "client-secret-0001", refreshToken: "rotated-refresh-0001", accessToken: "rotated-access-0001", accessTokenExpiresAt: 1 };

	// Removing `this.secrets.add(c.refreshToken)` or the accessToken line fails the matching assertion.
	it("save() tracks client secret, refresh token and access token", async () => {
		const secrets = new SecretRegistry();
		await new TrackingStore(new MemoryCredentialStore(), secrets).save(creds);
		const line = `leak ${creds.clientSecret} ${creds.refreshToken} ${creds.accessToken}`;
		const masked = redactSecrets(line, secrets.values());
		for (const v of [creds.clientSecret, creds.refreshToken, creds.accessToken as string]) assert.ok(!masked.includes(v), v);
	});

	it("load() tracks them too (credentials written by an earlier session)", async () => {
		const secrets = new SecretRegistry();
		await new TrackingStore(new MemoryCredentialStore(creds), secrets).load();
		const known = secrets.values();
		assert.ok(known.includes(creds.refreshToken) && known.includes(creds.accessToken as string) && known.includes(creds.clientSecret));
	});

	it("TrackingStore serialises save and clear in call order: a slow save cannot land after a later clear", async () => {
		const events: string[] = [];
		const slow: CredentialStore = {
			load: async () => undefined,
			save: async () => {
				await new Promise((r) => setTimeout(r, 30));
				events.push("saved");
			},
			clear: async () => void events.push("cleared"),
		};
		const store = new TrackingStore(slow, new SecretRegistry());
		const a = store.save(creds);
		const b = store.clear();
		await Promise.all([a, b]);
		assert.deepEqual(events, ["saved", "cleared"]);
	});
});

describe("F5: setCredentials makes the token manager forget the old pair", () => {
	// Without `tokens.reset()` after the save the poller's cached (old) pair is used for the next refresh.
	it("the next refresh after setCredentials sends the NEW refresh token", async (t) => {
		const api = await startApiDouble(t);
		const dataDir = await makeTempDir(t);
		const file = new FileCredentialStore({ dataDir, logger: new RecordingLogger() });
		await file.save(seed);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		let now = 1_700_000_100_000;
		const service = createWeatherService({ baseUrl: api.baseUrl, dataDir, logger: new RecordingLogger(), random: () => 0.5, now: () => now });
		t.after(() => service.dispose());
		const sub = service.subscribe(() => undefined);
		t.after(() => sub.unsubscribe());
		await until(() => service.getSnapshot() !== undefined, "first poll with the seeded credentials");
		const first = api.requestsTo(TOKEN).length;
		const result = await service.setCredentials({ clientId: "client-id-0002", clientSecret: "client-secret-0002", refreshToken: "pasted-refresh-0002" });
		assert.ok(result.ok);
		const saved = (await file.load())!;
		now += 4 * 3600_000; // access token expired, rate-limit gap passed
		await service.refresh();
		const bodies = api.requestsTo(TOKEN).slice(first + 1).map((r) => new URLSearchParams(r.body).get("refresh_token"));
		assert.deepEqual(bodies, [saved.refreshToken], "the refresh after the sign-in must start from the saved pair");
	});
});

// ---------------------------------------------------------------------------------------
// security F6: the service tells the PI whether the pair was saved
// ---------------------------------------------------------------------------------------

describe("F6: setCredentials reports saved:true when only the data load failed", () => {
	async function make(t: TestContext) {
		const api = await startApiDouble(t);
		const dataDir = await makeTempDir(t);
		const service = createWeatherService({ baseUrl: api.baseUrl, dataDir, logger: new RecordingLogger(), random: () => 0.5 });
		t.after(() => service.dispose());
		return { api, service };
	}
	const input = { clientId: "client-id-0001", clientSecret: "client-secret-0001", refreshToken: "pasted-refresh-0001" };

	it("refresh ok, data 503: ok:false, saved:true", async (t) => {
		const { api, service } = await make(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, (_req, res) => sendJson(res, 503, {}));
		const result = await service.setCredentials(input);
		assert.equal(result.ok, false);
		assert.ok(!result.ok && result.saved === true);
	});

	it("refresh rejected: ok:false and NOT saved", async (t) => {
		const { api, service } = await make(t);
		api.route(TOKEN, (_req, res) => sendJson(res, 400, { error: "invalid_grant" }));
		const result = await service.setCredentials(input);
		assert.ok(!result.ok && result.saved !== true);
	});
});

// ---------------------------------------------------------------------------------------
// security F7: redaction spellings
// ---------------------------------------------------------------------------------------

describe("F7: redaction covers the spellings a secret takes in a log line", () => {
	const secret = "ab\"cd\\ef/gh~i!j(k)*l'm n"; // every character that changes under some encoding
	const lowerHex = (s: string) => s.replace(/%(?:25)*[0-9A-F]{2}/g, (m) => m.toLowerCase());
	const spellings: Array<[string, string]> = [
		["raw", secret],
		["encodeURIComponent", encodeURIComponent(secret)],
		["form encoding (URLSearchParams, + for space)", new URLSearchParams({ x: secret }).toString().slice(2)],
		["JSON-escaped", JSON.stringify(secret).slice(1, -1)],
		["JSON-escaped with escaped slash", JSON.stringify(secret).slice(1, -1).replaceAll("/", "\\/")],
		["JSON inside JSON", JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1)],
		["percent-encoded twice", encodeURIComponent(encodeURIComponent(secret))],
		["lower-case percent hex", lowerHex(encodeURIComponent(secret))],
		["lower-case form hex", lowerHex(new URLSearchParams({ x: secret }).toString().slice(2))],
		["lower-case hex, encoded twice", lowerHex(encodeURIComponent(encodeURIComponent(secret)))],
		["base64", Buffer.from(secret).toString("base64")],
		["base64url", Buffer.from(secret).toString("base64url")],
	];
	for (const [name, spelling] of spellings) {
		it(`known secret, ${name}`, () => {
			const out = redactSecrets(`value=${spelling}; trailing`, [secret]);
			assert.ok(!out.includes(spelling), `${name} leaked: ${out}`);
		});
	}

	it("the form-encoded spelling really contains a + and the harness sees it (control)", () => {
		assert.ok(new URLSearchParams({ x: secret }).toString().includes("+"));
		assert.equal(redactSecrets("nothing here", [secret]), "nothing here");
	});

	// patterns (no known secret): every output must lose the value but keep the surrounding structure
	const patterns: Array<[string, string, string]> = [
		["key: value", "client_secret: VALUE0001", "VALUE0001"],
		["key = value", "refresh_token = VALUE0002", "VALUE0002"],
		["form body", "grant_type=refresh_token&refresh_token=VALUE0003&client_id=ID1", "VALUE0003"],
		["percent-encoded form body", "body=refresh_token%3DVALUE0004%26client_secret%3DVALUE0005&x=1", "VALUE0004"],
		["percent-encoded form body, second key", "body=refresh_token%3DVALUE0004%26client_secret%3DVALUE0005&x=1", "VALUE0005"],
		["single-quoted dict", "{'client_secret': 'VALUE0006', 'a': 1}", "VALUE0006"],
		["double-quoted JSON", '{"refresh_token":"VALUE0007","b":2}', "VALUE0007"],
		["JSON inside a JSON string", '{\\"refresh_token\\":\\"VALUE0008\\",\\"b\\":1}', "VALUE0008"],
		["upper-case key", "CLIENT_SECRET=VALUE0009", "VALUE0009"],
		["prefixed key", "old_refresh_token=VALUE0010", "VALUE0010"],
		["token bar encoded as %7C", `tok ${"a1".repeat(12)}%7C${"b2".repeat(16)} end`, "a1a1a1"],
	];
	for (const [name, text, value] of patterns) {
		it(`pattern: ${name}`, () => {
			const out = redactSecrets(text);
			assert.ok(!out.includes(value), out);
		});
	}

	it("keeps unrelated structure intact", () => {
		assert.equal(redactSecrets("error_code=3 client_id=ID1 expires_in=10800"), "error_code=3 client_id=ID1 expires_in=10800");
		assert.ok(redactSecrets("grant_type=refresh_token&refresh_token=VALUE0003&client_id=ID1").endsWith("&client_id=ID1"));
		assert.ok(redactSecrets('{"refresh_token":"VALUE0007","b":2}').endsWith(',"b":2}'));
	});
});

// ---------------------------------------------------------------------------------------
// security F11: which 4xx from the token endpoint are credential rejections
// ---------------------------------------------------------------------------------------

describe("F11: only a body that names a credential rejection is sticky", () => {
	async function one(t: TestContext, status: number, body: unknown, now = () => 1_700_000_000_000) {
		const api = await startApiDouble(t);
		api.route(TOKEN, (_req, res) => {
			if (typeof body === "string") {
				res.writeHead(status, { "Content-Type": "text/html" });
				res.end(body);
			} else sendJson(res, status, body);
		});
		const tokens = new TokenManager({ store: new MemoryCredentialStore(seed), baseUrl: api.baseUrl, logger: new RecordingLogger(), now });
		const error = await tokens.getAccessToken().then(
			() => undefined,
			(e: unknown) => e as NetatmoError,
		);
		assert.ok(error instanceof NetatmoError);
		// ask again: sticky means the second call never reaches the service
		await tokens.getAccessToken().catch(() => undefined);
		return { error, requests: api.requestsTo(TOKEN).length };
	}

	// Before the fix every 4xx except 408/429 was `auth` and sticky; these now retry (kind "protocol").
	const transientConfig: Array<[string, number, unknown]> = [
		["bare 401 from a gateway (HTML)", 401, "<html>unauthorised</html>"],
		["bare 403 (HTML)", 403, "<html>forbidden</html>"],
		["404 from a mis-routed proxy", 404, { error: { code: 9 } }],
		["400 unsupported_grant_type (our request, not the user's secret)", 400, { error: "unsupported_grant_type" }],
		["400 invalid_scope", 400, { error: "invalid_scope" }],
		["400 without a body", 400, {}],
	];
	for (const [name, status, body] of transientConfig) {
		it(`${name}: protocol error, NOT sticky (second call retries)`, async (t) => {
			const r = await one(t, status, body);
			assert.equal(r.error.kind, "protocol");
			assert.equal(r.requests, 2);
		});
	}

	const credentialRejections: Array<[string, number, unknown]> = [
		["400 invalid_grant", 400, { error: "invalid_grant" }],
		["400 invalid_client (live probe with a bogus token)", 400, { error: "invalid_client" }],
		["401 unauthorized_client", 401, { error: "unauthorized_client" }],
		["400 invalid_request", 400, { error: "invalid_request" }],
		["403 API code 30", 403, { error: { code: 30 } }],
		["406 API code 5 (application deactivated)", 406, { error: { code: 5 } }],
	];
	for (const [name, status, body] of credentialRejections) {
		it(`${name}: auth, sticky (second call does not reach the service)`, async (t) => {
			const r = await one(t, status, body);
			assert.equal(r.error.kind, "auth");
			assert.equal(r.requests, 1);
		});
	}

	it("403 code 26 (usage limit) is rate-limited with a pause, not an auth error", async (t) => {
		const now = 1_700_000_000_000;
		const r = await one(t, 403, { error: { code: 26 } }, () => now);
		assert.equal(r.error.kind, "rate-limited");
		assert.equal(r.error.retryAt, now + USAGE_LIMIT_PAUSE_MS);
		assert.equal(r.requests, 2);
	});
});

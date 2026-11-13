import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FileCredentialStore, MemoryCredentialStore, type CredentialStore, type StoredCredentials } from "../src/adapter/station/credentials.ts";
import { NetatmoClient } from "../src/adapter/station/client.ts";
import { NetatmoError } from "../src/adapter/station/errors.ts";
import { TokenManager } from "../src/adapter/station/token-manager.ts";
import { RecordingLogger, makeTempDir, sendJson, startApiDouble, stationsOk, tokenIssuer } from "./station-helpers.ts";

const seed: StoredCredentials = { clientId: "client-id-0001", clientSecret: "client-secret-0001", refreshToken: "seed-refresh-0001" };
const TOKEN = "POST /oauth2/token";
const STATIONS = "GET /api/getstationsdata";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TokenManager: rotation", () => {
	it("persists the rotated pair on disk even when the first API call afterwards fails", async (t) => {
		const dir = await makeTempDir(t);
		const store = new FileCredentialStore({ dataDir: dir });
		await store.save(seed);
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, (_req, res) => sendJson(res, 500, { error: { code: 2 } })); // the "process dies" between refresh and use
		const tokens = new TokenManager({ logger: new RecordingLogger(), store, baseUrl: api.baseUrl });
		const client = new NetatmoClient({ logger: new RecordingLogger(), tokens, baseUrl: api.baseUrl });
		await assert.rejects(client.fetchSnapshot(), (e: unknown) => e instanceof NetatmoError && e.kind === "transient");
		// a fresh process reading the file sees the rotated token, not the seed
		const onDisk = await new FileCredentialStore({ dataDir: dir }).load();
		assert.equal(onDisk?.refreshToken, "fake-refresh-1");
		assert.equal(onDisk?.accessToken, "fake-access-1");
		assert.equal(onDisk?.clientSecret, seed.clientSecret);
		// the refresh request carried the seed token, the form fields and the documented content type
		const body = new URLSearchParams(api.requestsTo(TOKEN)[0]!.body);
		assert.equal(body.get("grant_type"), "refresh_token");
		assert.equal(body.get("refresh_token"), seed.refreshToken);
		assert.equal(body.get("client_id"), seed.clientId);
		assert.equal(body.get("client_secret"), seed.clientSecret);
		assert.match(String(api.requestsTo(TOKEN)[0]!.headers["content-type"]), /^application\/x-www-form-urlencoded/);
	});

	it("persists BEFORE the new access token is handed to the caller", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		const events: string[] = [];
		const slow: CredentialStore = {
			load: async () => seed,
			save: async () => {
				await delay(40);
				events.push("saved");
			},
			clear: async () => undefined,
		};
		const tokens = new TokenManager({ logger: new RecordingLogger(), store: slow, baseUrl: api.baseUrl });
		const token = await tokens.getAccessToken();
		events.push("returned");
		assert.equal(token, "fake-access-1");
		assert.deepEqual(events, ["saved", "returned"]);
	});

	it("keeps working from memory when persisting fails, and retries the write later", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		const logger = new RecordingLogger();
		let failing = true;
		let saved: StoredCredentials | undefined;
		const flaky: CredentialStore = {
			load: async () => seed,
			save: async (c) => {
				if (failing) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
				saved = c;
			},
			clear: async () => undefined,
		};
		const tokens = new TokenManager({ store: flaky, baseUrl: api.baseUrl, logger });
		assert.equal(await tokens.getAccessToken(), "fake-access-1");
		assert.equal(tokens.hasUnpersistedRotation, true);
		assert.ok(logger.text().includes("ENOSPC"));
		failing = false;
		assert.equal(await tokens.getAccessToken(), "fake-access-1", "still the cached token");
		assert.equal(tokens.hasUnpersistedRotation, false);
		assert.equal(saved?.refreshToken, "fake-refresh-1");
		assert.equal(api.requestsTo(TOKEN).length, 1);
	});
});

describe("TokenManager: single flight and expiry", () => {
	it("ten concurrent callers cause exactly one refresh request", async (t) => {
		const api = await startApiDouble(t);
		const issue = tokenIssuer();
		api.route(TOKEN, async (req, res) => {
			await delay(50);
			await issue(req, res);
		});
		const tokens = new TokenManager({ logger: new RecordingLogger(), store: new MemoryCredentialStore(seed), baseUrl: api.baseUrl });
		const results = await Promise.all(Array.from({ length: 10 }, () => tokens.getAccessToken()));
		assert.equal(api.requestsTo(TOKEN).length, 1);
		assert.equal(new Set(results).size, 1);
	});

	it("ten concurrent snapshot fetches share one refresh as well", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		const tokens = new TokenManager({ logger: new RecordingLogger(), store: new MemoryCredentialStore(seed), baseUrl: api.baseUrl });
		const client = new NetatmoClient({ logger: new RecordingLogger(), tokens, baseUrl: api.baseUrl });
		await Promise.all(Array.from({ length: 10 }, () => client.fetchSnapshot()));
		assert.equal(api.requestsTo(TOKEN).length, 1);
		assert.equal(api.requestsTo(STATIONS).length, 10);
	});

	it("forceRefresh coalesces with a running refresh and skips one that already happened", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		const tokens = new TokenManager({ logger: new RecordingLogger(), store: new MemoryCredentialStore(seed), baseUrl: api.baseUrl });
		const first = await tokens.getAccessToken();
		// two callers both saw `first` rejected
		const [a, b] = await Promise.all([tokens.forceRefresh(first), tokens.forceRefresh(first)]);
		assert.equal(a, b);
		assert.notEqual(a, first);
		assert.equal(api.requestsTo(TOKEN).length, 2);
		// a late caller that was rejected with the OLD token gets the current one without a request
		assert.equal(await tokens.forceRefresh(first), a);
		assert.equal(api.requestsTo(TOKEN).length, 2);
	});

	it("refreshes 60 s before expiry and not earlier", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, tokenIssuer());
		let now = 1_700_000_000_000;
		const tokens = new TokenManager({ logger: new RecordingLogger(), store: new MemoryCredentialStore(seed), baseUrl: api.baseUrl, now: () => now });
		assert.equal(await tokens.getAccessToken(), "fake-access-1"); // expires in 10800 s
		now += 10_800_000 - 61_000;
		assert.equal(await tokens.getAccessToken(), "fake-access-1");
		assert.equal(api.requestsTo(TOKEN).length, 1);
		now += 2_000; // now only 59 s left
		assert.equal(await tokens.getAccessToken(), "fake-access-2");
		assert.equal(api.requestsTo(TOKEN).length, 2);
	});

	it("uses a still-valid stored access token without any request", async (t) => {
		const api = await startApiDouble(t);
		const now = 1_700_000_000_000;
		const store = new MemoryCredentialStore({ ...seed, accessToken: "stored-access", accessTokenExpiresAt: now + 3_600_000 });
		const tokens = new TokenManager({ logger: new RecordingLogger(), store, baseUrl: api.baseUrl, now: () => now });
		assert.equal(await tokens.getAccessToken(), "stored-access");
		assert.equal(api.requests.length, 0);
	});
});

describe("TokenManager: failures", () => {
	it("a rejected refresh token is auth-error and is NEVER sent again (no retry loop)", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, (_req, res) => sendJson(res, 400, { error: "invalid_grant", error_description: "ignored" }));
		const store = new MemoryCredentialStore(seed);
		const tokens = new TokenManager({ logger: new RecordingLogger(), store, baseUrl: api.baseUrl });
		for (let i = 0; i < 4; i++) {
			await assert.rejects(tokens.getAccessToken(), (e: unknown) => e instanceof NetatmoError && e.kind === "auth" && e.code === "invalid_grant");
		}
		await assert.rejects(tokens.forceRefresh("whatever"), (e: unknown) => e instanceof NetatmoError && e.kind === "auth");
		assert.equal(api.requestsTo(TOKEN).length, 1, "only the first attempt may reach the service");
		assert.equal(store.value?.refreshToken, seed.refreshToken, "the stored credentials are untouched");
		// after the user supplies new credentials the manager tries again
		tokens.reset();
		await store.save({ ...seed, refreshToken: "seed-refresh-0002" });
		await assert.rejects(tokens.getAccessToken());
		assert.equal(api.requestsTo(TOKEN).length, 2);
	});

	it("maps the documented rejection shapes to auth", async (t) => {
		const api = await startApiDouble(t);
		const shapes: Array<[number, unknown]> = [
			[400, { error: "invalid_request" }],
			[400, { error: "invalid_client" }],
			[403, { error: { code: 30, message: "Invalid refresh token" } }],
			[401, { error: "unauthorized_client" }],
		];
		for (const [status, body] of shapes) {
			api.route(TOKEN, (_req, res) => sendJson(res, status, body));
			const tokens = new TokenManager({ logger: new RecordingLogger(), store: new MemoryCredentialStore(seed), baseUrl: api.baseUrl });
			await assert.rejects(tokens.getAccessToken(), (e: unknown) => e instanceof NetatmoError && e.kind === "auth", `${status} ${JSON.stringify(body)}`);
		}
	});

	it("429, 5xx, HTML error pages and network errors are transient and do not poison the token", async (t) => {
		const api = await startApiDouble(t);
		const store = new MemoryCredentialStore(seed);
		const tokens = new TokenManager({ logger: new RecordingLogger(), store, baseUrl: api.baseUrl });
		api.route(TOKEN, (_req, res) => sendJson(res, 429, { error: { code: 28 } }, { "Retry-After": "30" }));
		await assert.rejects(tokens.getAccessToken(), (e: unknown) => e instanceof NetatmoError && e.kind === "rate-limited" && e.retryAt !== undefined);
		api.route(TOKEN, (_req, res) => {
			res.writeHead(502, { "Content-Type": "text/html" });
			res.end("<html>bad gateway</html>");
		});
		await assert.rejects(tokens.getAccessToken(), (e: unknown) => e instanceof NetatmoError && e.kind === "transient");
		await api.close();
		await assert.rejects(tokens.getAccessToken(), (e: unknown) => e instanceof NetatmoError && e.kind === "transient" && /Network error/.test(e.message));
		assert.equal(store.value?.refreshToken, seed.refreshToken);
		assert.equal(tokens.refreshRequests, 3, "transient failures are retried on the next call (not sticky)");
	});

	it("a 200 without both tokens is a protocol error and keeps the old token", async (t) => {
		const api = await startApiDouble(t);
		api.route(TOKEN, (_req, res) => sendJson(res, 200, { access_token: "only-access-token", expires_in: 10800 }));
		const store = new MemoryCredentialStore(seed);
		const tokens = new TokenManager({ logger: new RecordingLogger(), store, baseUrl: api.baseUrl });
		await assert.rejects(tokens.getAccessToken(), (e: unknown) => e instanceof NetatmoError && e.kind === "protocol");
		assert.equal(store.saveCount, 0);
	});

	it("without stored credentials: auth error 'no-credentials', no request", async (t) => {
		const api = await startApiDouble(t);
		const tokens = new TokenManager({ logger: new RecordingLogger(), store: new MemoryCredentialStore(), baseUrl: api.baseUrl });
		assert.equal(await tokens.hasCredentials(), false);
		await assert.rejects(tokens.getAccessToken(), (e: unknown) => e instanceof NetatmoError && e.kind === "auth" && e.code === "no-credentials");
		assert.equal(api.requests.length, 0);
	});

	it("refuses clear-text http to a non-loopback host", () => {
		assert.throws(() => new TokenManager({ logger: new RecordingLogger(), store: new MemoryCredentialStore(seed), baseUrl: "http://example.com" }), /https/);
		assert.doesNotThrow(() => new TokenManager({ logger: new RecordingLogger(), store: new MemoryCredentialStore(seed), baseUrl: "https://example.com" }));
	});
});

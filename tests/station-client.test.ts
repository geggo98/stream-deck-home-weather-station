import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { MemoryCredentialStore } from "../src/adapter/station/credentials.ts";
import { MAX_IN_REQUEST_WAIT_MS, NetatmoClient, USAGE_LIMIT_PAUSE_MS } from "../src/adapter/station/client.ts";
import { NetatmoError } from "../src/adapter/station/errors.ts";
import { parseRetryAfter } from "../src/adapter/station/http.ts";
import { apiErrorCode, oauthErrorType } from "../src/adapter/station/oauth.ts";
import { TokenManager } from "../src/adapter/station/token-manager.ts";
import { type ApiDouble, RecordingLogger, fixture, sendJson, startApiDouble, stationsOk, tokenIssuer } from "./station-helpers.ts";
import type { TestContext } from "node:test";

const TOKEN = "POST /oauth2/token";
const STATIONS = "GET /api/getstationsdata";
const seed = { clientId: "client-id-0001", clientSecret: "client-secret-0001", refreshToken: "seed-refresh-0001" };

interface Setup {
	api: ApiDouble;
	client: NetatmoClient;
	tokens: TokenManager;
	sleeps: number[];
}

async function setup(t: TestContext, extra: { timeoutMs?: number; maxResponseBytes?: number; now?: () => number; stored?: boolean } = {}): Promise<Setup> {
	const api = await startApiDouble(t);
	api.route(TOKEN, tokenIssuer());
	const store = new MemoryCredentialStore(
		extra.stored === false ? seed : { ...seed, accessToken: "stale-access", accessTokenExpiresAt: Date.now() + 3_600_000 },
	);
	const tokens = new TokenManager({ store, baseUrl: api.baseUrl, logger: new RecordingLogger() });
	const sleeps: number[] = [];
	const client = new NetatmoClient({
		logger: new RecordingLogger(),
		tokens,
		baseUrl: api.baseUrl,
		timeoutMs: extra.timeoutMs,
		maxResponseBytes: extra.maxResponseBytes,
		now: extra.now,
		sleep: async (ms) => void sleeps.push(ms),
	});
	return { api, client, tokens, sleeps };
}

const kindOf = (kind: NetatmoError["kind"]) => (e: unknown) => e instanceof NetatmoError && e.kind === kind;

describe("NetatmoClient: request and success", () => {
	it("GETs getstationsdata with get_favorites=false and a bearer token, and parses the fixture", async (t) => {
		const { api, client } = await setup(t);
		api.route(STATIONS, stationsOk());
		const snap = await client.fetchSnapshot();
		assert.equal(snap.stations[0]!.modules.length, 5);
		const req = api.requestsTo(STATIONS)[0]!;
		assert.equal(req.url, "/api/getstationsdata?get_favorites=false");
		assert.equal(req.headers.authorization, "Bearer stale-access");
		assert.match(String(req.headers.accept), /application\/json/);
		assert.equal(api.requestsTo(TOKEN).length, 0, "a valid stored token needs no refresh");
	});

	it("can POST the same endpoint for the probe (form body)", async (t) => {
		const { api, client } = await setup(t);
		api.route("POST /api/getstationsdata", stationsOk());
		await client.getStationsDataRaw({ method: "POST" });
		const req = api.requestsTo("POST /api/getstationsdata")[0]!;
		assert.equal(req.body, "get_favorites=false");
		assert.match(String(req.headers["content-type"]), /x-www-form-urlencoded/);
	});

	it("refuses clear-text http to a non-loopback host", () => {
		assert.throws(() => new NetatmoClient({ tokens: new TokenManager({ store: new MemoryCredentialStore(), baseUrl: "https://x.example" }), baseUrl: "http://x.example" }), /https/);
	});
});

describe("NetatmoClient: token expiry", () => {
	for (const [status, code] of [[401, 3], [401, 2], [403, 3]] as const) {
		it(`${status} code ${code}: refresh once, retry once, with the NEW token`, async (t) => {
			const { api, client } = await setup(t);
			api.route(STATIONS, [
				(_req, res) => sendJson(res, status, { error: { code, message: "expired" } }),
				stationsOk(),
			]);
			const snap = await client.fetchSnapshot();
			assert.equal(snap.stations.length, 1);
			assert.equal(api.requestsTo(TOKEN).length, 1);
			const calls = api.requestsTo(STATIONS);
			assert.equal(calls.length, 2);
			assert.equal(calls[0]!.headers.authorization, "Bearer stale-access");
			assert.equal(calls[1]!.headers.authorization, "Bearer fake-access-1");
		});
	}

	it("a second rejection after the refresh is an auth error and no third request is made", async (t) => {
		const { api, client } = await setup(t);
		api.route(STATIONS, (_req, res) => sendJson(res, 401, { error: { code: 3 } }));
		await assert.rejects(client.fetchSnapshot(), kindOf("auth"));
		assert.equal(api.requestsTo(STATIONS).length, 2);
		assert.equal(api.requestsTo(TOKEN).length, 1);
	});

	it("if the refresh token is rejected during the retry, the error is auth and nothing loops", async (t) => {
		const { api, client } = await setup(t);
		api.route(TOKEN, (_req, res) => sendJson(res, 400, { error: "invalid_grant" }));
		api.route(STATIONS, (_req, res) => sendJson(res, 401, { error: { code: 3 } }));
		await assert.rejects(client.fetchSnapshot(), kindOf("auth"));
		await assert.rejects(client.fetchSnapshot(), kindOf("auth"));
		assert.equal(api.requestsTo(TOKEN).length, 1);
	});
});

describe("NetatmoClient: documented error codes", () => {
	const table: Array<[string, number, unknown, NetatmoError["kind"]]> = [
		["403 code 30 invalid refresh token", 403, { error: { code: 30 } }, "auth"],
		["403 code 13 operation forbidden", 403, { error: { code: 13 } }, "auth"],
		["403 code 26 maximum usage", 403, { error: { code: 26 } }, "rate-limited"],
		["403 unknown code", 403, { error: { code: 99 } }, "protocol"],
		["406 code 5 application deactivated", 406, { error: { code: 5 } }, "auth"],
		["406 other", 406, { error: { code: 7 } }, "protocol"],
		["500", 500, { error: { code: 2 } }, "transient"],
		["503 without body", 503, undefined, "transient"],
		["404", 404, { error: { code: 9 } }, "protocol"],
		["400 oauth-style body", 400, { error: "invalid_request" }, "protocol"],
	];
	for (const [name, status, body, kind] of table) {
		it(`${name} -> ${kind}`, async (t) => {
			const { api, client } = await setup(t);
			api.route(STATIONS, (_req, res) => {
				if (body === undefined) {
					res.writeHead(status);
					res.end();
				} else sendJson(res, status, body);
			});
			await assert.rejects(client.fetchSnapshot(), kindOf(kind));
			assert.equal(api.requestsTo(TOKEN).length, 0, "no refresh for non-expiry errors");
		});
	}

	it("403 code 26 carries a pause so the poller does not hammer", async (t) => {
		const now = 1_700_000_000_000;
		const { api, client } = await setup(t, { now: () => now });
		api.route(STATIONS, (_req, res) => sendJson(res, 403, { error: { code: 26 } }));
		await assert.rejects(client.fetchSnapshot(), (e: unknown) => e instanceof NetatmoError && e.retryAt === now + USAGE_LIMIT_PAUSE_MS);
	});

	it("distinguishes OAuth error bodies from API error bodies", () => {
		assert.equal(oauthErrorType({ error: "invalid_grant", error_description: "x" }), "invalid_grant");
		assert.equal(oauthErrorType({ error: { code: 3 } }), undefined);
		assert.equal(oauthErrorType({ error: "Not A Token!" }), undefined);
		assert.equal(apiErrorCode({ error: { code: 3, message: "x" } }), "3");
		assert.equal(apiErrorCode({ error: { code: "26" } }), "26");
		assert.equal(apiErrorCode({ error: "invalid_grant" }), undefined);
		assert.equal(apiErrorCode({ error: { code: { nested: 1 } } }), undefined);
		assert.equal(apiErrorCode(null), undefined);
	});
});

describe("NetatmoClient: 429 and Retry-After", () => {
	it("waits a Retry-After in seconds once, then succeeds", async (t) => {
		const { api, client, sleeps } = await setup(t);
		api.route(STATIONS, [(_req, res) => sendJson(res, 429, { error: { code: 28 } }, { "Retry-After": "7" }), stationsOk()]);
		await client.fetchSnapshot();
		assert.deepEqual(sleeps, [7000]);
		assert.equal(api.requestsTo(STATIONS).length, 2);
	});

	it("understands an HTTP-date Retry-After", async (t) => {
		const now = Date.parse("2026-11-13T12:00:00Z");
		const { api, client, sleeps } = await setup(t, { now: () => now });
		const date = new Date(now + 20_000).toUTCString();
		api.route(STATIONS, [(_req, res) => sendJson(res, 429, { error: { code: 28 } }, { "Retry-After": date }), stationsOk()]);
		await client.fetchSnapshot();
		assert.deepEqual(sleeps, [20_000]);
	});

	it("does not sleep beyond the cap; hands a retryAt to the poller instead", async (t) => {
		const now = 1_700_000_000_000;
		const { api, client, sleeps } = await setup(t, { now: () => now });
		api.route(STATIONS, (_req, res) => sendJson(res, 429, { error: { code: 28 } }, { "Retry-After": "120" }));
		await assert.rejects(client.fetchSnapshot(), (e: unknown) => e instanceof NetatmoError && e.kind === "rate-limited" && e.retryAt === now + 120_000);
		assert.deepEqual(sleeps, []);
		assert.equal(api.requestsTo(STATIONS).length, 1);
		assert.equal(MAX_IN_REQUEST_WAIT_MS, 60_000);
	});

	it("gives up after one wait when the second answer is a 429 again", async (t) => {
		const { api, client, sleeps } = await setup(t);
		api.route(STATIONS, (_req, res) => sendJson(res, 429, { error: { code: 28 } }, { "Retry-After": "1" }));
		await assert.rejects(client.fetchSnapshot(), kindOf("rate-limited"));
		assert.equal(sleeps.length, 1);
		assert.equal(api.requestsTo(STATIONS).length, 2);
	});

	it("429 without Retry-After: rate-limited, no retryAt, no sleep", async (t) => {
		const { api, client, sleeps } = await setup(t);
		api.route(STATIONS, (_req, res) => sendJson(res, 429, { error: { code: 28 } }));
		await assert.rejects(client.fetchSnapshot(), (e: unknown) => e instanceof NetatmoError && e.kind === "rate-limited" && e.retryAt === undefined);
		assert.deepEqual(sleeps, []);
	});

	it("parseRetryAfter handles seconds, dates, past dates and garbage", () => {
		const now = Date.parse("2026-11-13T12:00:00Z");
		assert.equal(parseRetryAfter("5", now), 5000);
		assert.equal(parseRetryAfter(" 0 ", now), 0);
		assert.equal(parseRetryAfter(new Date(now + 3000).toUTCString(), now), 3000);
		assert.equal(parseRetryAfter(new Date(now - 3000).toUTCString(), now), 0);
		assert.equal(parseRetryAfter("soon", now), undefined);
		assert.equal(parseRetryAfter("-5", now), undefined);
		assert.equal(parseRetryAfter(null, now), undefined);
	});
});

describe("NetatmoClient: hostile or broken responses", () => {
	it("aborts an oversized streaming body instead of buffering it", async (t) => {
		const { api, client } = await setup(t, { maxResponseBytes: 64 * 1024 });
		let closedEarly!: () => void;
		const closed = new Promise<void>((resolve) => (closedEarly = resolve));
		let written = 0;
		api.route(STATIONS, (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			const chunk = Buffer.alloc(16 * 1024, 0x61);
			res.on("close", closedEarly);
			const pump = () => {
				// endless stream: the test only ends because the client hangs up
				while (res.writable && !res.destroyed) {
					written += chunk.length;
					if (!res.write(chunk)) {
						res.once("drain", pump);
						return;
					}
					if (written > 100 * 1024 * 1024) return;
				}
			};
			pump();
		});
		await assert.rejects(client.fetchSnapshot(), (e: unknown) => e instanceof NetatmoError && e.kind === "protocol" && /larger/.test(e.message));
		await closed;
		assert.ok(written < 50 * 1024 * 1024, `server wrote ${written} bytes before the client hung up`);
	});

	it("rejects a declared Content-Length above the cap without reading the body", async (t) => {
		const { api, client } = await setup(t, { maxResponseBytes: 1024 });
		api.route(STATIONS, (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "5000" });
			res.write("{");
		});
		await assert.rejects(client.fetchSnapshot(), kindOf("protocol"));
	});

	it("malformed JSON, non-objects and a failing status are protocol errors", async (t) => {
		const { api, client } = await setup(t);
		const bodies: Array<(res: http.ServerResponse) => void> = [
			(res) => res.end("{not json"),
			(res) => res.end(""),
			(res) => res.end("[1,2,3]"),
			(res) => res.end('"just a string"'),
			(res) => res.end(JSON.stringify({ status: "failed", body: {} })),
			(res) => res.end(JSON.stringify({ status: "ok" })),
			(res) => res.end(JSON.stringify({ status: "ok", body: "nope" })),
		];
		for (const [i, write] of bodies.entries()) {
			api.route(STATIONS, (_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				write(res);
			});
			await assert.rejects(client.fetchSnapshot(), kindOf("protocol"), `body #${i}`);
		}
	});

	it("times out when the server never answers", async (t) => {
		const { api, client } = await setup(t, { timeoutMs: 80 });
		api.route(STATIONS, () => undefined); // never responds
		const started = Date.now();
		await assert.rejects(client.fetchSnapshot(), (e: unknown) => e instanceof NetatmoError && e.kind === "transient" && /timed out/.test(e.message));
		assert.ok(Date.now() - started < 3000);
	});

	it("times out when the body stalls after the headers", async (t) => {
		const { api, client } = await setup(t, { timeoutMs: 80 });
		api.route(STATIONS, (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.write('{"status":"ok",');
		});
		await assert.rejects(client.fetchSnapshot(), (e: unknown) => e instanceof NetatmoError && e.kind === "transient" && /timed out/.test(e.message));
	});

	it("does not follow redirects (credentials must not travel to another host)", async (t) => {
		const { api, client } = await setup(t);
		api.route(STATIONS, (_req, res) => {
			res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" });
			res.end();
		});
		await assert.rejects(client.fetchSnapshot(), kindOf("transient"));
	});

	it("a refused connection is a transient network error naming only the code", async (t) => {
		const { api, client } = await setup(t);
		await api.close();
		await assert.rejects(client.fetchSnapshot(), (e: unknown) => e instanceof NetatmoError && e.kind === "transient" && /Network error \(ECONNREFUSED\)/.test(e.message));
	});

	it("an empty device list still parses (no station)", async (t) => {
		const { api, client } = await setup(t);
		api.route(STATIONS, stationsOk(fixture("stations-empty")));
		assert.equal((await client.fetchSnapshot()).stations.length, 0);
	});
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, it, type TestContext } from "node:test";
import { FileCredentialStore } from "../src/adapter/station/credentials.ts";
import { createWeatherService } from "../src/adapter/station/create-service.ts";
import type { WeatherService } from "../src/adapter/station/service.ts";
import { RecordingLogger, makeTempDir, sendJson, startApiDouble, stationsOk, tokenIssuer } from "./station-helpers.ts";

const TOKEN = "POST /oauth2/token";
const STATIONS = "GET /api/getstationsdata";
const input = { clientId: "client-id-0001", clientSecret: "client-secret-0001", refreshToken: "pasted-refresh-0001" };

async function make(t: TestContext) {
	const api = await startApiDouble(t);
	const dataDir = await makeTempDir(t);
	const logger = new RecordingLogger();
	const service = createWeatherService({ baseUrl: api.baseUrl, dataDir, logger, random: () => 0.5 });
	t.after(() => service.dispose());
	return { api, dataDir, logger, service, store: new FileCredentialStore({ dataDir, logger: new RecordingLogger() }) };
}

describe("WeatherService.setCredentials", () => {
	it("validates through refresh + getstationsdata, persists the ROTATED pair, and adopts the snapshot", async (t) => {
		const { api, service, store } = await make(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, stationsOk());
		assert.deepEqual(await service.getCredentialSummary(), { configured: false });
		const result = await service.setCredentials({ ...input, clientId: `  ${input.clientId} ` });
		assert.ok(result.ok);
		assert.equal(result.ok && result.snapshot.stations.length, 1);
		const saved = await store.load();
		assert.equal(saved?.refreshToken, "fake-refresh-1");
		assert.equal(saved?.clientId, input.clientId, "input is trimmed");
		assert.equal(api.requestsTo(STATIONS)[0]!.headers.authorization, "Bearer fake-access-1");
		assert.deepEqual(await service.getCredentialSummary(), { configured: true, clientIdHint: "0001" });
		// the poller now serves the validated snapshot without asking again
		assert.ok(service.getSnapshot());
		assert.deepEqual(service.getConnectionState(), { kind: "ok" });
		const sub = service.subscribe(() => undefined);
		await new Promise((r) => setTimeout(r, 50));
		sub.unsubscribe();
		assert.equal(api.requestsTo(STATIONS).length, 1, "no second request right after validation");
	});

	it("a rejected refresh token reports a safe error and leaves existing credentials untouched", async (t) => {
		const { api, service, store, logger } = await make(t);
		await store.save({ clientId: "old-client-id", clientSecret: "old-client-secret", refreshToken: "old-refresh-token" });
		api.route(TOKEN, (_req, res) => sendJson(res, 400, { error: "invalid_grant", error_description: `bad ${input.refreshToken}` }));
		const result = await service.setCredentials(input);
		assert.equal(result.ok, false);
		assert.ok(!result.ok && /rejected|revoked/.test(result.error));
		assert.ok(!result.ok && !result.error.includes(input.refreshToken));
		assert.equal((await store.load())?.refreshToken, "old-refresh-token");
		assert.equal(api.requestsTo(STATIONS).length, 0);
		assert.ok(!logger.text().includes(input.refreshToken));
	});

	it("persists the rotated token even if the station request after a successful refresh fails", async (t) => {
		const { api, service, store } = await make(t);
		api.route(TOKEN, tokenIssuer());
		api.route(STATIONS, (_req, res) => sendJson(res, 503, { error: { code: 2 } }));
		const result = await service.setCredentials(input);
		assert.equal(result.ok, false);
		assert.ok(!result.ok && /Signed in, but loading station data failed/.test(result.error));
		assert.equal((await store.load())?.refreshToken, "fake-refresh-1", "the pasted token is dead after the refresh; the new one must survive");
	});

	it("rejects malformed input without any network traffic", async (t) => {
		const { api, service } = await make(t);
		for (const bad of [{ ...input, clientId: "" }, { ...input, refreshToken: "has space inside" }, { ...input, clientSecret: "x".repeat(600) }]) {
			const result = await service.setCredentials(bad);
			assert.equal(result.ok, false);
		}
		assert.equal(api.requests.length, 0);
	});

	it("refuses a second overlapping validation", async (t) => {
		const { api, service } = await make(t);
		api.route(TOKEN, async (req, res) => {
			await new Promise((r) => setTimeout(r, 60));
			await tokenIssuer()(req, res);
		});
		api.route(STATIONS, stationsOk());
		const [a, b] = await Promise.all([service.setCredentials(input), service.setCredentials(input)]);
		assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
	});
});

describe("WeatherService: polling, clearing, disposing", () => {
	async function configured(t: TestContext): Promise<ReturnType<typeof make> extends Promise<infer R> ? R : never> {
		const ctx = await make(t);
		await ctx.store.save({ ...input, accessToken: "stored-access", accessTokenExpiresAt: Date.now() + 3_600_000 });
		ctx.api.route(TOKEN, tokenIssuer());
		ctx.api.route(STATIONS, stationsOk());
		return ctx;
	}

	it("polls on subscribe and notifies listeners", async (t) => {
		const { service, api } = await configured(t);
		let notified = 0;
		const sub = service.subscribe(() => notified++);
		for (let i = 0; i < 100 && !service.getSnapshot(); i++) await new Promise((r) => setTimeout(r, 10));
		sub.unsubscribe();
		assert.ok(service.getSnapshot());
		assert.ok(notified >= 1);
		assert.equal(api.requestsTo(STATIONS).length, 1);
		assert.equal(api.requestsTo(TOKEN).length, 0);
	});

	it("without credentials: no-credentials and no request", async (t) => {
		const { service, api } = await make(t);
		const sub = service.subscribe(() => undefined);
		await new Promise((r) => setTimeout(r, 50));
		sub.unsubscribe();
		assert.deepEqual(service.getConnectionState(), { kind: "no-credentials" });
		assert.equal(api.requests.length, 0);
	});

	it("clearCredentials removes the file, drops the snapshot and shows no-credentials", async (t) => {
		const { service, store } = await configured(t);
		const sub = service.subscribe(() => undefined);
		for (let i = 0; i < 100 && !service.getSnapshot(); i++) await new Promise((r) => setTimeout(r, 10));
		await service.clearCredentials();
		sub.unsubscribe();
		assert.equal(await store.load(), undefined);
		assert.equal(service.getSnapshot(), undefined);
		assert.deepEqual(service.getConnectionState(), { kind: "no-credentials" });
		assert.deepEqual(await service.getCredentialSummary(), { configured: false });
	});

	it("a revoked refresh token ends in auth-error and stops asking", async (t) => {
		const { service, api, store } = await make(t);
		await store.save(input); // no access token: first poll refreshes
		api.route(TOKEN, (_req, res) => sendJson(res, 400, { error: "invalid_grant" }));
		const sub = service.subscribe(() => undefined);
		for (let i = 0; i < 100 && service.getConnectionState().kind !== "auth-error"; i++) await new Promise((r) => setTimeout(r, 10));
		sub.unsubscribe();
		assert.equal(service.getConnectionState().kind, "auth-error");
		await service.refresh();
		assert.equal(api.requestsTo(TOKEN).length, 1);
	});

	it("dispose is idempotent and later calls fail safely", async (t) => {
		const { service } = await make(t);
		service.dispose();
		service.dispose();
		const result = await service.setCredentials(input);
		assert.equal(result.ok, false);
		const phases: string[] = [];
		await service.startBrowserLogin({ clientId: "a", clientSecret: "b" }, async () => undefined, (p) => phases.push(p.phase));
		assert.deepEqual(phases, ["error"]);
	});

	it("browser login through the service persists and starts polling", async (t) => {
		const ctx = await make(t);
		ctx.api.route(TOKEN, tokenIssuer("svc"));
		ctx.api.route(STATIONS, stationsOk());
		const service: WeatherService = createWeatherService({ baseUrl: ctx.api.baseUrl, dataDir: ctx.dataDir, loopbackPort: 0, logger: ctx.logger });
		t.after(() => service.dispose());
		const phases: string[] = [];
		const sub = service.subscribe(() => undefined);
		await service.startBrowserLogin(
			{ clientId: input.clientId, clientSecret: input.clientSecret },
			async (url) => {
				const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
				const state = new URL(url).searchParams.get("state")!;
				// the "browser": follows the redirect to the loopback listener
				void fetch(`http://127.0.0.1:${redirect.port}/callback?code=svc-code-0001&state=${encodeURIComponent(state)}`);
			},
			(p) => phases.push(p.phase),
		);
		sub.unsubscribe();
		assert.deepEqual(phases, ["waiting", "done"]);
		assert.equal((await ctx.store.load())?.refreshToken, "svc-refresh-1");
		assert.ok(service.getSnapshot(), "polling started after the login");
		await fs.stat(ctx.store.filePath);
	});
});

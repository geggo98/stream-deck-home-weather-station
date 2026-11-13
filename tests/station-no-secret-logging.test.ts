/**
 * "Test that no code path logs a secret": run the failure paths of every component with
 * distinctive fake secrets, make the test double ECHO those secrets back in error bodies,
 * and grep everything that could reach a human: recorded log lines, thrown error messages,
 * the connection state the poller exposes.
 *
 * The components log through the injected logger WITHOUT the redacting wrapper of
 * create-service.ts, so this proves the code itself is clean, not that the wrapper saves it.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, it } from "node:test";
import { FileCredentialStore, MemoryCredentialStore, type CredentialStore } from "../src/adapter/station/credentials.ts";
import { NetatmoClient } from "../src/adapter/station/client.ts";
import { Poller } from "../src/adapter/station/poller.ts";
import { TokenManager } from "../src/adapter/station/token-manager.ts";
import { RecordingLogger, makeTempDir, sendJson, startApiDouble, stationsOk } from "./station-helpers.ts";

const CLIENT_SECRET = "CS-distinctive-9f3a1c77d2";
const REFRESH_SEED = "RT-distinctive-71bc03e8aa";
const ISSUED_ACCESS = "AT-distinctive-5d20be19c4";
const ISSUED_REFRESH = "RT-distinctive-rotated-88e1f0";
const STALE_ACCESS = "AT-distinctive-stale-3b7a";
const SECRETS = [CLIENT_SECRET, REFRESH_SEED, ISSUED_ACCESS, ISSUED_REFRESH, STALE_ACCESS];

const TOKEN = "POST /oauth2/token";
const STATIONS = "GET /api/getstationsdata";

const echo = `echo: ${SECRETS.join(" ")} Bearer ${ISSUED_ACCESS} refresh_token=${REFRESH_SEED}&client_secret=${CLIENT_SECRET}`;

describe("no secret reaches a log line, an error message or the exposed state", () => {
	it("across every failure path", async (t) => {
		const logger = new RecordingLogger();
		const messages: string[] = [];
		const api = await startApiDouble(t);
		const dir = await makeTempDir(t);
		const record = async (work: Promise<unknown>) => {
			try {
				await work;
			} catch (error) {
				messages.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
			}
		};
		const make = (store: CredentialStore, extra: { timeoutMs?: number; maxResponseBytes?: number } = {}) => {
			const tokens = new TokenManager({ store, baseUrl: api.baseUrl, logger, timeoutMs: extra.timeoutMs });
			const client = new NetatmoClient({ tokens, baseUrl: api.baseUrl, logger, sleep: async () => undefined, ...extra });
			return { tokens, client };
		};
		const fresh = () => new MemoryCredentialStore({ clientId: "client-id-0001", clientSecret: CLIENT_SECRET, refreshToken: REFRESH_SEED, accessToken: STALE_ACCESS, accessTokenExpiresAt: Date.now() + 3_600_000 });
		const expired = () => new MemoryCredentialStore({ clientId: "client-id-0001", clientSecret: CLIENT_SECRET, refreshToken: REFRESH_SEED });

		// 1. refresh rejected, body echoes everything
		api.route(TOKEN, (_req, res) => sendJson(res, 400, { error: "invalid_grant", error_description: echo }));
		await record(make(expired()).client.fetchSnapshot());
		// 2. refresh 429 / 502 echoing the secrets in plain text
		api.route(TOKEN, (_req, res) => sendJson(res, 429, { error: { code: 28, message: echo } }, { "Retry-After": "5" }));
		await record(make(expired()).client.fetchSnapshot());
		api.route(TOKEN, (_req, res) => {
			res.writeHead(502, { "Content-Type": "text/plain" });
			res.end(echo);
		});
		await record(make(expired()).client.fetchSnapshot());
		// 3. refresh 200 but garbage that contains the secrets
		api.route(TOKEN, (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(`{"access_token":"${ISSUED_ACCESS}", "oops": ${echo}`);
		});
		await record(make(expired()).client.fetchSnapshot());
		// 4. refresh fine, stations fail in many ways, each echoing
		api.route(TOKEN, (_req, res) => sendJson(res, 200, { access_token: ISSUED_ACCESS, refresh_token: ISSUED_REFRESH, expires_in: 10800 }));
		for (const [status, body] of [
			[401, { error: { code: 3, message: echo } }],
			[403, { error: { code: 30, message: echo } }],
			[403, { error: { code: 26, message: echo } }],
			[406, { error: { code: 5, message: echo } }],
			[500, { error: { code: 2, message: echo } }],
			[429, { error: { code: 28, message: echo } }],
			[418, { teapot: echo }],
		] as const) {
			api.route(STATIONS, (_req, res) => sendJson(res, status, body, status === 429 ? { "Retry-After": "300" } : {}));
			await record(make(fresh()).client.fetchSnapshot());
			await record(make(expired()).client.fetchSnapshot());
		}
		api.route(STATIONS, (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(`${echo} {not json`);
		});
		await record(make(fresh()).client.fetchSnapshot());
		// 5. oversized, timeout, refused connection
		api.route(STATIONS, (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(echo.repeat(2000));
		});
		await record(make(fresh(), { maxResponseBytes: 1024 }).client.fetchSnapshot());
		api.route(STATIONS, () => undefined);
		await record(make(fresh(), { timeoutMs: 50 }).client.fetchSnapshot());
		api.route(STATIONS, stationsOk());
		// 6. persistence failure whose error message contains the secret
		const leakyStore: CredentialStore = {
			load: async () => ({ clientId: "client-id-0001", clientSecret: CLIENT_SECRET, refreshToken: REFRESH_SEED }),
			save: async () => {
				throw Object.assign(new Error(`cannot write ${ISSUED_REFRESH} ${CLIENT_SECRET}`), { code: "EACCES" });
			},
			clear: async () => undefined,
		};
		await record(make(leakyStore).client.fetchSnapshot());
		// 7. corrupt credentials file containing the secrets
		const file = new FileCredentialStore({ dataDir: dir, logger });
		await fs.writeFile(file.filePath, `{"version":1,"clientSecret":"${CLIENT_SECRET}","refreshToken":"${REFRESH_SEED}` + " truncated");
		assert.equal(await file.load(), undefined);
		// 8. the poller exposes errors in its state
		const states: string[] = [];
		api.route(TOKEN, (_req, res) => sendJson(res, 400, { error: "invalid_grant", error_description: echo }));
		const live = make(expired());
		const poller = new Poller({ fetchSnapshot: () => live.client.fetchSnapshot(), hasCredentials: () => live.tokens.hasCredentials(), logger });
		poller.subscribe(() => states.push(JSON.stringify(poller.getConnectionState())));
		await poller.whenIdle();
		poller.dispose();
		api.route(STATIONS, stationsOk());

		// ---- validate the scan before believing "no hits" ----
		assert.ok(messages.length >= 15, `only ${messages.length} error messages were collected: the scan would prove little`);
		assert.ok(logger.lines.length >= 15, `only ${logger.lines.length} log lines were recorded`);
		assert.ok(states.length >= 1 && states.some((s) => s.includes("auth-error")), "the poller state was captured");
		assert.ok(api.requests.length >= 15);
		// the double really did echo the secrets (the premise of the test)
		assert.ok(echo.includes(CLIENT_SECRET));

		const haystack = [...logger.lines, ...messages, ...states].join("\n");
		for (const secret of SECRETS) assert.ok(!haystack.includes(secret), `secret leaked: ${secret.slice(0, 8)}...`);
		for (const fragment of ["Bearer AT-", "client_secret=", "refresh_token=", "echo:"]) {
			assert.ok(!haystack.includes(fragment), `fragment of a response body leaked: ${fragment}`);
		}
	});
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { describe, it, type TestContext } from "node:test";
import { startBrowserLogin, type BrowserLoginHandle } from "../src/adapter/station/browser-login.ts";
import { FileCredentialStore, type CredentialStore, type StoredCredentials } from "../src/adapter/station/credentials.ts";
import type { BrowserLoginPhase } from "../src/adapter/station/service.ts";
import { RecordingLogger, makeTempDir, sendJson, startApiDouble, tokenIssuer } from "./station-helpers.ts";

const CODE = "auth-code-distinctive-0001";

interface Flow {
	handle: BrowserLoginHandle;
	phases: BrowserLoginPhase[];
	opened: string[];
	redirectUri: () => string;
	port: () => number;
	state: () => string;
	api: Awaited<ReturnType<typeof startApiDouble>>;
	store: FileCredentialStore;
	logger: RecordingLogger;
}

interface FlowExtra {
	loginTimeoutMs?: number;
	port?: number;
	openUrl?: (url: string) => Promise<void>;
	/** Replaces the file store (the Flow's `store` stays the real, unused one). */
	store?: CredentialStore;
	onSaveFailed?: (credentials: StoredCredentials) => void;
	onSuccess?: () => void;
}

async function flow(t: TestContext, extra: FlowExtra = {}): Promise<Flow> {
	const api = await startApiDouble(t);
	api.route("POST /oauth2/token", tokenIssuer("login"));
	const store = new FileCredentialStore({ dataDir: await makeTempDir(t), logger: new RecordingLogger() });
	const phases: BrowserLoginPhase[] = [];
	const opened: string[] = [];
	const logger = new RecordingLogger();
	const handle = startBrowserLogin({
		clientId: "client-id-0001",
		clientSecret: "client-secret-0001",
		port: extra.port ?? 0,
		store: extra.store ?? store,
		onSaveFailed: extra.onSaveFailed,
		onSuccess: extra.onSuccess,
		baseUrl: api.baseUrl,
		logger,
		loginTimeoutMs: extra.loginTimeoutMs,
		openUrl: extra.openUrl ?? (async (url) => void opened.push(url)),
		onPhase: (p) => phases.push(p),
	});
	t.after(() => handle.cancel());
	// wait for the listener
	for (let i = 0; i < 200 && !phases.some((p) => p.phase === "waiting" || p.phase === "error"); i++) await new Promise((r) => setTimeout(r, 5));
	const waiting = phases.find((p) => p.phase === "waiting");
	const redirectUri = () => (waiting && waiting.phase === "waiting" ? waiting.redirectUri : "");
	return {
		handle,
		phases,
		opened,
		api,
		store,
		logger,
		redirectUri,
		port: () => Number(new URL(redirectUri()).port),
		state: () => new URL(opened[0]!).searchParams.get("state")!,
	};
}

function request(port: number, path: string, options: { method?: string; host?: string } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.host ? { Host: options.host } : {}, agent: false }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
		});
		req.on("error", reject);
		req.end();
	});
}

const refused = (port: number) =>
	new Promise<boolean>((resolve) => {
		const socket = net.connect(port, "127.0.0.1");
		socket.on("connect", () => {
			socket.destroy();
			resolve(false);
		});
		socket.on("error", () => resolve(true));
	});

describe("browser login", () => {
	it("builds the authorize URL, accepts the genuine callback, exchanges the code and persists the tokens", async (t) => {
		const f = await flow(t);
		assert.equal(f.opened.length, 1);
		const url = new URL(f.opened[0]!);
		assert.equal(url.origin + url.pathname, `${f.api.baseUrl}/oauth2/authorize`);
		assert.equal(url.searchParams.get("client_id"), "client-id-0001");
		assert.equal(url.searchParams.get("scope"), "read_station");
		assert.equal(url.searchParams.get("redirect_uri"), `http://localhost:${f.port()}/callback`);
		assert.ok(f.state().length >= 24, "state is random and long enough");

		const res = await request(f.port(), `/callback?code=${CODE}&state=${encodeURIComponent(f.state())}`);
		assert.equal(res.status, 200);
		assert.ok(!res.body.includes(CODE));
		await f.handle.finished;

		const form = new URLSearchParams(f.api.requestsTo("POST /oauth2/token")[0]!.body);
		assert.equal(form.get("grant_type"), "authorization_code");
		assert.equal(form.get("code"), CODE);
		assert.equal(form.get("redirect_uri"), `http://localhost:${f.port()}/callback`);
		assert.equal(form.get("scope"), "read_station");
		assert.equal(form.get("client_secret"), "client-secret-0001");
		const saved = await f.store.load();
		assert.equal(saved?.refreshToken, "login-refresh-1");
		assert.equal(saved?.clientId, "client-id-0001");
		assert.deepEqual(f.phases.map((p) => p.phase), ["waiting", "done"]);
		assert.ok(await refused(f.port()), "the listener is closed after the first valid callback");
		assert.ok(!f.logger.text().includes(CODE), "the authorization code is never logged");
		assert.ok(!f.logger.text().includes("login-refresh-1"));
	});

	it("ignores wrong state, wrong path, wrong method and foreign Host headers, and keeps waiting", async (t) => {
		const f = await flow(t);
		const port = f.port();
		assert.equal((await request(port, `/callback?code=${CODE}&state=wrong`)).status, 400);
		assert.equal((await request(port, `/callback?code=${CODE}`)).status, 400);
		assert.equal((await request(port, `/other?code=${CODE}&state=${f.state()}`)).status, 404);
		assert.equal((await request(port, `/callback?code=${CODE}&state=${f.state()}`, { method: "POST" })).status, 400);
		assert.equal((await request(port, `/callback?code=${CODE}&state=${f.state()}`, { host: "evil.example" })).status, 400);
		assert.equal((await request(port, `/callback?code=${CODE}&state=${f.state()}`, { host: `evil.example:${port}` })).status, 400);
		assert.deepEqual(f.phases.map((p) => p.phase), ["waiting"], "stray requests must not end the flow");
		assert.equal(f.api.requestsTo("POST /oauth2/token").length, 0);
		// the genuine callback still works afterwards, with either allowed host spelling
		assert.equal((await request(port, `/callback?code=${CODE}&state=${f.state()}`, { host: `localhost:${port}` })).status, 200);
		await f.handle.finished;
		assert.equal(f.phases.at(-1)?.phase, "done");
	});

	it("never reflects request content and reports a denied authorization with a fixed message", async (t) => {
		const f = await flow(t);
		const res = await request(f.port(), `/callback?state=${f.state()}&error=${encodeURIComponent("<script>alert(1)</script>")}`);
		assert.equal(res.status, 400);
		assert.ok(!res.body.includes("script") && !res.body.includes("alert"));
		assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
		await f.handle.finished;
		const last = f.phases.at(-1)!;
		assert.equal(last.phase, "error");
		assert.ok(last.phase === "error" && !last.message.includes("script"));
		assert.ok(await refused(f.port()));
	});

	it("times out and closes the listener", async (t) => {
		const f = await flow(t, { loginTimeoutMs: 60 });
		await f.handle.finished;
		const last = f.phases.at(-1)!;
		assert.ok(last.phase === "error" && /timed out/i.test(last.message));
		assert.ok(await refused(f.port()));
	});

	it("a failing code exchange is an error phase and writes nothing", async (t) => {
		const f = await flow(t);
		f.api.route("POST /oauth2/token", (_req, res) => sendJson(res, 400, { error: "invalid_grant", error_description: `code ${CODE} expired` }));
		await request(f.port(), `/callback?code=${CODE}&state=${f.state()}`);
		await f.handle.finished;
		const last = f.phases.at(-1)!;
		assert.equal(last.phase, "error");
		assert.ok(last.phase === "error" && !last.message.includes(CODE));
		assert.equal(await f.store.load(), undefined);
		assert.ok(!f.logger.text().includes(CODE));
	});

	it("cancel() ends the flow with an error phase and closes the listener", async (t) => {
		const f = await flow(t);
		f.handle.cancel("cancelled by test");
		await f.handle.finished;
		assert.deepEqual(f.phases.at(-1), { phase: "error", message: "cancelled by test" });
		assert.ok(await refused(f.port()));
	});

	it("reports a busy port", async (t) => {
		const blocker = net.createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		t.after(() => blocker.close());
		const port = (blocker.address() as net.AddressInfo).port;
		const f = await flow(t, { port });
		await f.handle.finished;
		const last = f.phases.at(-1)!;
		assert.ok(last.phase === "error" && /already in use/.test(last.message));
	});

	it("reports a browser that cannot be opened", async (t) => {
		const f = await flow(t, { openUrl: async () => Promise.reject(new Error("no browser")) });
		await f.handle.finished;
		const last = f.phases.at(-1)!;
		assert.ok(last.phase === "error" && /browser/i.test(last.message));
	});

	it("listens on the loopback interface only", async (t) => {
		const external = Object.values(os.networkInterfaces())
			.flat()
			.find((i) => i && i.family === "IPv4" && !i.internal);
		if (!external) return t.skip("no non-loopback IPv4 interface on this machine");
		const f = await flow(t);
		const reachable = await new Promise<boolean>((resolve) => {
			const s = net.connect(f.port(), external.address);
			// a filtered port neither connects nor refuses: that also means "not reachable", and must not hang the suite
			s.setTimeout(1500, () => {
				s.destroy();
				resolve(false);
			});
			s.on("connect", () => {
				s.destroy();
				resolve(true);
			});
			s.on("error", () => resolve(false));
		});
		assert.equal(reachable, false);
	});

	it("leaves no credentials file when nothing succeeded", async (t) => {
		const f = await flow(t, { loginTimeoutMs: 40 });
		await f.handle.finished;
		await assert.rejects(fs.stat(f.store.filePath));
	});
});

// ---------------------------------------------------------------------------------------
// review 3 (T3, S3)
// ---------------------------------------------------------------------------------------

function gate(): { wait: Promise<void>; release: () => void } {
	let release: () => void = () => undefined;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
}

const until = async (condition: () => boolean, what: string): Promise<void> => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(condition(), `timed out waiting for ${what}`);
};

describe("browser login: cancel and commit", () => {
	// Without the `committing` guard in cancel(), the cancel ends the flow as an error although the write goes through.
	it("a cancel while the credentials are being written is too late: the flow still ends as done", async (t) => {
		const g = gate();
		const inner = new FileCredentialStore({ dataDir: await makeTempDir(t), logger: new RecordingLogger() });
		const store: CredentialStore = {
			load: () => inner.load(),
			clear: () => inner.clear(),
			save: async (c) => {
				await g.wait;
				await inner.save(c);
			},
		};
		const f = await flow(t, { store });
		await request(f.port(), `/callback?code=${CODE}&state=${f.state()}`);
		await until(() => f.api.requestsTo("POST /oauth2/token").length === 1, "the code exchange");
		await new Promise((r) => setTimeout(r, 30)); // the exchange answered, save is now blocked
		f.handle.cancel("cancel during the write");
		g.release();
		await f.handle.finished;
		assert.deepEqual(f.phases.map((p) => p.phase), ["waiting", "done"]);
		assert.equal((await inner.load())?.refreshToken, "login-refresh-1");
	});
});

describe("browser login: strict request checks", () => {
	// Prefix and suffix matches on the Host header would accept all three.
	it("rejects look-alike Host headers with 400 and keeps waiting", async (t) => {
		const f = await flow(t);
		const port = f.port();
		const url = `/callback?code=${CODE}&state=${f.state()}`;
		for (const host of [`localhost.evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost:${port + 1}`, `xlocalhost:${port}`, `localhost:${port}x`]) {
			assert.equal((await request(port, url, { host })).status, 400, host);
		}
		assert.deepEqual(f.phases.map((p) => p.phase), ["waiting"]);
		assert.equal(f.api.requestsTo("POST /oauth2/token").length, 0);
	});

	// Without `server.close()` right after the first valid callback, the second one starts a second exchange.
	it("a second valid callback while the exchange runs makes no second token request", async (t) => {
		const g = gate();
		const f = await flow(t);
		f.api.route("POST /oauth2/token", async (_req, res) => {
			await g.wait;
			sendJson(res, 200, { access_token: "login-access-1", refresh_token: "login-refresh-1", expires_in: 10800 });
		});
		const port = f.port();
		const url = `/callback?code=${CODE}&state=${f.state()}`;
		assert.equal((await request(port, url)).status, 200);
		await until(() => f.api.requestsTo("POST /oauth2/token").length === 1, "the first exchange");
		const second = await request(port, url).then((r) => r.status, () => "refused");
		assert.ok(second === "refused" || second === 410, `second callback: ${second}`);
		g.release();
		await f.handle.finished;
		assert.equal(f.api.requestsTo("POST /oauth2/token").length, 1);
		assert.deepEqual(f.phases.map((p) => p.phase), ["waiting", "done"]);
	});

	it("a valid state without a code ends the flow with a fixed message", async (t) => {
		const f = await flow(t);
		assert.equal((await request(f.port(), `/callback?state=${f.state()}`)).status, 400);
		await f.handle.finished;
		const last = f.phases.at(-1)!;
		assert.ok(last.phase === "error" && /no authorization code/.test(last.message));
		assert.equal(f.api.requestsTo("POST /oauth2/token").length, 0);
	});

	// 512 characters is the limit (MAX_CODE_LENGTH): one more is refused before any request.
	it("accepts a code of 512 characters and refuses 513", async (t) => {
		const ok = await flow(t);
		await request(ok.port(), `/callback?code=${"c".repeat(512)}&state=${ok.state()}`);
		await ok.handle.finished;
		assert.equal(ok.api.requestsTo("POST /oauth2/token").length, 1);
		const long = await flow(t);
		assert.equal((await request(long.port(), `/callback?code=${"c".repeat(513)}&state=${long.state()}`)).status, 400);
		await long.handle.finished;
		assert.equal(long.api.requestsTo("POST /oauth2/token").length, 0);
		assert.equal(long.phases.at(-1)?.phase, "error");
	});

	it("sets Referrer-Policy and the other fixed headers on every reply", async (t) => {
		const f = await flow(t);
		const res = await request(f.port(), "/nope");
		assert.equal(res.headers["referrer-policy"], "no-referrer");
		assert.equal(res.headers["x-content-type-options"], "nosniff");
		assert.equal(res.headers["cache-control"], "no-store");
	});
});

describe("browser login: a failing disk write is not a failed sign-in", () => {
	const failingStore = (code: string): CredentialStore => ({
		load: async () => undefined,
		clear: async () => undefined,
		save: async () => {
			throw Object.assign(new Error("/private/path/credentials.json.tmp: write failed"), { code });
		},
	});

	// Before: the save sat inside the exchange's try, so this was logged as "code exchange failed" (warn) and shown as "Sign-in failed".
	it("says the credentials could not be saved, logs the errno at error level, and hands the grant to onSaveFailed", async (t) => {
		const saved: StoredCredentials[] = [];
		const f = await flow(t, { store: failingStore("ENOSPC"), onSaveFailed: (c) => void saved.push(c) });
		await request(f.port(), `/callback?code=${CODE}&state=${f.state()}`);
		await f.handle.finished;
		const last = f.phases.at(-1)!;
		assert.ok(last.phase === "error");
		assert.equal(last.phase === "error" && last.message, "Signed in at Netatmo, but the credentials could not be saved to disk (ENOSPC). Free disk space or check permissions, then try again.");
		assert.match(f.logger.text(), /ERROR could not save the credentials after sign-in \(ENOSPC\)/);
		assert.ok(!/code exchange failed/.test(f.logger.text()));
		assert.ok(!f.logger.text().includes("/private/path"), "the error message (paths) is not logged");
		assert.equal(saved.length, 1);
		assert.equal(saved[0]?.refreshToken, "login-refresh-1");
	});

	it("a throwing onSuccess does not turn saved credentials into an error", async (t) => {
		const f = await flow(t, {
			onSuccess: () => {
				throw new Error("restart failed");
			},
		});
		await request(f.port(), `/callback?code=${CODE}&state=${f.state()}`);
		await f.handle.finished;
		assert.equal(f.phases.at(-1)?.phase, "done");
		assert.equal((await f.store.load())?.refreshToken, "login-refresh-1");
		assert.match(f.logger.text(), /ERROR after-sign-in step failed: Error: restart failed/);
	});
});

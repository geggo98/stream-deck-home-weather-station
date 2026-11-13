import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
	CREDENTIALS_FILE_NAME,
	FileCredentialStore,
	MAX_CREDENTIALS_FILE_BYTES,
	type StoredCredentials,
	validateCredentials,
} from "../src/adapter/station/credentials.ts";
import { RecordingLogger, makeTempDir } from "./station-helpers.ts";

const creds: StoredCredentials = {
	clientId: "client-id-0001",
	clientSecret: "client-secret-0001",
	refreshToken: "refresh-token-0001",
	accessToken: "access-token-0001",
	accessTokenExpiresAt: 1_700_000_000_000,
};

describe("FileCredentialStore", () => {
	it("round-trips, creates the directory, and writes mode 0600", { skip: process.platform === "win32" }, async (t) => {
		const dir = path.join(await makeTempDir(t), "nested", "home-weather-station");
		const store = new FileCredentialStore({ dataDir: dir });
		assert.equal(await store.load(), undefined);
		await store.save(creds);
		assert.deepEqual(await store.load(), creds);
		const mode = (await fs.stat(path.join(dir, CREDENTIALS_FILE_NAME))).mode & 0o777;
		assert.equal(mode, 0o600);
	});

	it("stays 0600 when the file is overwritten and under a permissive umask", { skip: process.platform === "win32" }, async (t) => {
		const dir = await makeTempDir(t);
		const store = new FileCredentialStore({ dataDir: dir });
		const old = process.umask(0o000);
		try {
			await store.save(creds);
			await store.save({ ...creds, refreshToken: "refresh-token-0002" });
		} finally {
			process.umask(old);
		}
		assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
		assert.equal((await store.load())?.refreshToken, "refresh-token-0002");
	});

	it("leaves no temp files behind", async (t) => {
		const dir = await makeTempDir(t);
		const store = new FileCredentialStore({ dataDir: dir });
		await Promise.all([1, 2, 3, 4, 5].map((n) => store.save({ ...creds, refreshToken: `refresh-token-${n}` })));
		assert.deepEqual(await fs.readdir(dir), [CREDENTIALS_FILE_NAME]);
	});

	it("keeps the old file intact and removes the temp file when the rename fails", async (t) => {
		const dir = await makeTempDir(t);
		const good = new FileCredentialStore({ dataDir: dir });
		await good.save(creds);
		const failing = new FileCredentialStore({
			dataDir: dir,
			renameFile: async () => {
				throw Object.assign(new Error("simulated"), { code: "EIO" });
			},
		});
		await assert.rejects(failing.save({ ...creds, refreshToken: "refresh-token-new" }), /simulated/);
		assert.equal((await good.load())?.refreshToken, creds.refreshToken);
		assert.deepEqual(await fs.readdir(dir), [CREDENTIALS_FILE_NAME]);
	});

	it("a concurrent reader never sees a partial file (atomic replace)", async (t) => {
		const dir = await makeTempDir(t);
		const store = new FileCredentialStore({ dataDir: dir });
		await store.save(creds);
		let stop = false;
		let bad = 0;
		let reads = 0;
		const reader = (async () => {
			while (!stop) {
				reads++;
				if ((await store.load()) === undefined) bad++;
			}
		})();
		for (let n = 0; n < 60; n++) await store.save({ ...creds, refreshToken: `refresh-${"x".repeat(200)}-${n}` });
		stop = true;
		await reader;
		assert.ok(reads > 5, `reader ran ${reads} times`);
		assert.equal(bad, 0, "reader saw a missing or partial file");
	});

	it("treats corrupt, partial, foreign and oversized files as not configured, without logging content", async (t) => {
		const dir = await makeTempDir(t);
		const logger = new RecordingLogger();
		const store = new FileCredentialStore({ dataDir: dir, logger });
		const cases: Array<[string, string]> = [
			["not json", "{this is not json SECRET-IN-FILE"],
			["truncated", '{"version":1,"clientId":"a","clientSecret":"SECRET-IN-FILE","refreshTok'],
			["wrong version", JSON.stringify({ ...creds, version: 2 })],
			["no version", JSON.stringify(creds)],
			["wrong type", JSON.stringify({ version: 1, ...creds, refreshToken: 12345 })],
			["array", "[]"],
			["whitespace in token", JSON.stringify({ version: 1, ...creds, refreshToken: "has space" })],
			["oversized", "x".repeat(MAX_CREDENTIALS_FILE_BYTES + 1)],
		];
		for (const [name, content] of cases) {
			await fs.writeFile(store.filePath, content);
			assert.equal(await store.load(), undefined, name);
		}
		assert.ok(logger.lines.length >= cases.length, "every rejection is logged");
		assert.ok(!logger.text().includes("SECRET-IN-FILE"), "file content must not be logged");
	});

	it("a directory at the file path is not configured, not a crash", async (t) => {
		const dir = await makeTempDir(t);
		await fs.mkdir(path.join(dir, CREDENTIALS_FILE_NAME));
		assert.equal(await new FileCredentialStore({ dataDir: dir, logger: new RecordingLogger() }).load(), undefined);
	});

	it("refuses to save invalid credentials", async (t) => {
		const store = new FileCredentialStore({ dataDir: await makeTempDir(t) });
		await assert.rejects(store.save({ ...creds, refreshToken: "" }), /invalid/);
		await assert.rejects(store.save({ ...creds, clientSecret: "x".repeat(600) }), /invalid/);
	});

	it("clear removes the file and is idempotent", async (t) => {
		const store = new FileCredentialStore({ dataDir: await makeTempDir(t) });
		await store.save(creds);
		await store.clear();
		await store.clear();
		assert.equal(await store.load(), undefined);
	});
});

describe("validateCredentials", () => {
	it("drops a nonsensical expiry but keeps the refresh token usable", () => {
		const v = validateCredentials({ ...creds, accessTokenExpiresAt: "soon" });
		assert.equal(v?.refreshToken, creds.refreshToken);
		assert.equal(v?.accessToken, undefined);
	});
	it("rejects control characters", () => {
		assert.equal(validateCredentials({ ...creds, clientId: "a\nb" }), undefined);
	});
});

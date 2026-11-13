import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { ProbeStore, VIA_SECRETSPEC, checkRawOutPath, main, pressureFinding, secretspecInvocation, structureSignature, summarise } from "../scripts/probe-api.ts";
import { T0, fixture, makeTempDir, sendJson, startApiDouble, stationsOk, tokenIssuer } from "./station-helpers.ts";

/** The probe output must carry structure only. These markers are put into every identifying field. */
function marked() {
	const raw = fixture("stations-full");
	const d = raw.body.devices[0];
	d.home_name = "MARKER-HOME-NAME";
	d.module_name = "MARKER-MODULE-NAME";
	d.home_id = "MARKER-HOME-ID";
	d.place = { altitude: 400, location: [11 + 0.1111, 22 + 0.2222], timezone: "MARKER/ZONE", country: "MARKER-COUNTRY" };
	raw.body.user.mail = ["marker", "@", "mail.invalid"].join("");
	return raw;
}

describe("probe: summary", () => {
	const raw = marked();
	const lines = summarise(raw, T0);
	const text = lines.join("\n");

	it("is structural: types, keys, ages, flags, preferences", () => {
		assert.match(text, /stations: 1/);
		assert.match(text, /station #1: 5 module\(s\)/);
		for (const type of ["NAMain", "NAModule1", "NAModule2", "NAModule3", "NAModule4"]) assert.ok(text.includes(type), type);
		assert.match(text, /keys: AbsolutePressure, CO2, Humidity, Noise, Pressure/);
		assert.match(text, /age=1 min freshness=fresh/);
		assert.match(text, /preferences: unit=0 windunit=0 pressureunit=0/);
		assert.match(text, /lang=present reg_locale=present/);
	});

	it("never prints ids, names, coordinates, mail or measured values", () => {
		assert.ok(lines.length >= 10, "the scan must see real output");
		for (const forbidden of ["MARKER", "00:00:5e", "11.1111", "22.2222", "21.4", "1013.2", "Living room", "Garden", "Test Home", "@"]) {
			assert.ok(!text.includes(forbidden), forbidden);
		}
	});

	it("flags unknown dashboard keys by name", () => {
		const r = fixture("stations-full");
		r.body.devices[0].dashboard_data.brand_new_metric = 5;
		assert.match(summarise(r, T0).join("\n"), /UNKNOWN keys .*brand_new_metric/);
	});
});

describe("probe: findings", () => {
	it("pressure finding depends on altitude and ordering, and prints no values", () => {
		const r = marked();
		assert.match(pressureFinding(r), /Pressure is LARGER/);
		r.body.devices[0].dashboard_data.Pressure = 900;
		assert.match(pressureFinding(r), /SWAPPED/);
		r.body.devices[0].place.altitude = 10;
		assert.match(pressureFinding(r), /inconclusive/);
		assert.match(pressureFinding({ body: { devices: [] } }), /inconclusive/);
		assert.ok(!/\d{3,}/.test(pressureFinding(marked())));
	});

	it("structure signatures ignore values but notice a missing key", () => {
		const a = fixture("stations-full");
		const b = fixture("stations-full");
		b.body.devices[0].dashboard_data.Temperature = 1;
		assert.equal(structureSignature(a), structureSignature(b));
		delete b.body.devices[0].dashboard_data.Noise;
		assert.notEqual(structureSignature(a), structureSignature(b));
	});
});

describe("probe: ProbeStore persists the rotated token without ever using argv", () => {
	const creds = { clientId: "id-0001", clientSecret: "secret-0001", refreshToken: "old-refresh" };

	it("uses secretspec when it works", async () => {
		const seen: string[] = [];
		const store = new ProbeStore(creds, (token) => (seen.push(token), { ok: true }));
		await store.save({ ...creds, refreshToken: "new-refresh" });
		assert.deepEqual(seen, ["new-refresh"]);
		assert.deepEqual(store.report, { where: "secretspec" });
	});

	it("falls back to a 0600 file in a private directory and reports only its path", { skip: process.platform === "win32" }, async () => {
		const store = new ProbeStore(creds, () => ({ ok: false }));
		await store.save({ ...creds, refreshToken: "new-refresh-fallback" });
		const file = store.report?.path;
		assert.ok(file);
		try {
			assert.equal(fs.readFileSync(file, "utf8"), "new-refresh-fallback");
			assert.equal(fs.statSync(file).mode & 0o777, 0o600);
			assert.equal(fs.statSync(file.replace(/\/refresh-token$/, "")).mode & 0o777, 0o700);
		} finally {
			fs.rmSync(file.replace(/\/refresh-token$/, ""), { recursive: true, force: true });
		}
	});
});

describe("probe: main against a local double", () => {
	const env = { NETATMO_CLIENT_ID: "id-0001", NETATMO_CLIENT_SECRET: "secret-0001", NETATMO_REFRESH_TOKEN: "seed-refresh-0001" };

	async function capture(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
		const out: string[] = [];
		const err: string[] = [];
		const origLog = console.log;
		const origErr = console.error;
		console.log = (...a: unknown[]) => void out.push(a.join(" "));
		console.error = (...a: unknown[]) => void err.push(a.join(" "));
		try {
			return { code: await run(), out: out.join("\n"), err: err.join("\n") };
		} finally {
			console.log = origLog;
			console.error = origErr;
		}
	}

	it("persists the new token first, prints a structural summary, checks POST, exits 0", async (t) => {
		const api = await startApiDouble(t);
		api.route("POST /oauth2/token", tokenIssuer());
		api.route("GET /api/getstationsdata", stationsOk());
		api.route("POST /api/getstationsdata", stationsOk());
		const stored: string[] = [];
		const r = await capture(() => main([], env, { baseUrl: api.baseUrl, runSecretspec: (token) => (stored.push(token), { ok: true }) }));
		assert.equal(r.code, 0, r.err);
		assert.deepEqual(stored, ["fake-refresh-1"]);
		assert.match(r.out, /same structure as GET: yes/);
		assert.match(r.out, /parser: 1 station\(s\), 5 module\(s\) understood/);
		assert.ok(!r.out.includes("fake-refresh-1") && !r.err.includes("fake-refresh-1"), "the token is never printed");
		assert.ok(!(r.out + r.err).includes("secret-0001"));
	});

	it("persists the rotated token even when the data request fails, and exits 1", async (t) => {
		const api = await startApiDouble(t);
		api.route("POST /oauth2/token", tokenIssuer());
		api.route("GET /api/getstationsdata", (_req, res) => sendJson(res, 503, {}));
		const stored: string[] = [];
		const r = await capture(() => main([], env, { baseUrl: api.baseUrl, runSecretspec: (token) => (stored.push(token), { ok: true }) }));
		assert.equal(r.code, 1);
		assert.deepEqual(stored, ["fake-refresh-1"]);
	});

	it("exits 2 on a rejected refresh token and writes nothing", async (t) => {
		const api = await startApiDouble(t);
		api.route("POST /oauth2/token", (_req, res) => sendJson(res, 400, { error: "invalid_grant" }));
		const stored: string[] = [];
		const r = await capture(() => main([], env, { baseUrl: api.baseUrl, runSecretspec: (token) => (stored.push(token), { ok: true }) }));
		assert.equal(r.code, 2);
		assert.deepEqual(stored, []);
		assert.ok(!(r.out + r.err).includes("seed-refresh-0001"));
	});

	it("exits 1 without credentials when secretspec cannot be started", async () => {
		const r = await capture(() => main([], {}, { reexec: () => undefined }));
		assert.equal(r.code, 1);
		assert.match(r.err, /could not be started/);
		assert.match(r.err, /must be set/);
	});

	it("without the values it starts itself once through secretspec and returns that run's exit code (npm run probe just works)", async () => {
		const seen: Array<ReturnType<typeof secretspecInvocation>> = [];
		const r = await capture(() => main(["--history"], { HOME: "/home/example" }, { repoRoot: "/repo", reexec: (i) => (seen.push(i), 0) }));
		assert.equal(r.code, 0);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.command, "secretspec");
		assert.deepEqual(seen[0]?.args.slice(0, 3), ["run", "--", "node"]);
		assert.ok(seen[0]?.args.includes("--history"), "the arguments are passed on");
		assert.equal(seen[0]?.env[VIA_SECRETSPEC], "1");
		const failing = await capture(() => main([], {}, { reexec: () => 2 }));
		assert.equal(failing.code, 2, "the child's exit code is the probe's exit code");
	});

	it("never starts itself twice: inside the secretspec child a missing value is an error (no endless loop)", async () => {
		let calls = 0;
		const r = await capture(() => main([], { [VIA_SECRETSPEC]: "1" }, { reexec: () => (calls++, 0) }));
		assert.equal(calls, 0);
		assert.equal(r.code, 1);
		assert.match(r.err, /must be set/);
	});
});

describe("probe: how it starts itself through secretspec", () => {
	it("uses the local dotenv file as provider when none is chosen and the file exists", () => {
		const i = secretspecInvocation(["--history"], { PATH: "/bin" }, "/repo", (p) => p === "/repo/.env.local");
		assert.equal(i.env.SECRETSPEC_PROVIDER, "dotenv:///repo/.env.local");
		assert.deepEqual(i.args, ["run", "--", "node", "/repo/scripts/probe-api.ts", "--history"]);
		assert.equal(i.env.PATH, "/bin");
	});
	it("keeps a provider the user chose, and sets none when there is no dotenv file", () => {
		assert.equal(secretspecInvocation([], { SECRETSPEC_PROVIDER: "onepassword" }, "/repo", () => true).env.SECRETSPEC_PROVIDER, "onepassword");
		assert.equal(secretspecInvocation([], {}, "/repo", () => false).env.SECRETSPEC_PROVIDER, undefined);
	});
});

describe("probe: --raw-out must not land where `git add .` finds it", () => {
	const env = { NETATMO_CLIENT_ID: "id-0001", NETATMO_CLIENT_SECRET: "secret-0001", NETATMO_REFRESH_TOKEN: "seed-refresh-0001" };
	const quiet = async (run: () => Promise<number>) => {
		const out: string[] = [];
		const origLog = console.log;
		const origErr = console.error;
		console.log = (...a: unknown[]) => void out.push(a.join(" "));
		console.error = (...a: unknown[]) => void out.push(a.join(" "));
		try {
			return { code: await run(), text: out.join("\n") };
		} finally {
			console.log = origLog;
			console.error = origErr;
		}
	};

	// Before the fix any path was accepted: a capture inside the working tree was one `git add .` from a commit.
	it("refuses a target inside the repository unless git ignores it", async (t) => {
		const repo = await makeTempDir(t);
		fs.mkdirSync(path.join(repo, "ignored"));
		const inside = path.join(repo, "raw.json");
		const refused = checkRawOutPath(inside, { repoRoot: repo, isIgnored: () => false });
		assert.equal(refused.ok, false);
		assert.match(refused.value, /inside|working tree/);
		assert.equal(checkRawOutPath(path.join(repo, "ignored", "raw.json"), { repoRoot: repo, isIgnored: (p) => p.includes(`${path.sep}ignored${path.sep}`) }).ok, true);
		assert.equal(checkRawOutPath(path.join(repo, "raw.json"), { repoRoot: repo, isIgnored: (p) => p.includes(`${path.sep}ignored${path.sep}`) }).ok, false);
	});

	it("allows a target outside the repository, refuses a missing directory and an existing file", async (t) => {
		const repo = await makeTempDir(t);
		const elsewhere = await makeTempDir(t);
		assert.equal(checkRawOutPath(path.join(elsewhere, "raw.json"), { repoRoot: repo, isIgnored: () => false }).ok, true);
		assert.equal(checkRawOutPath(path.join(elsewhere, "nope", "raw.json"), { repoRoot: repo, isIgnored: () => false }).ok, false);
		fs.writeFileSync(path.join(elsewhere, "taken.json"), "x");
		const taken = checkRawOutPath(path.join(elsewhere, "taken.json"), { repoRoot: repo, isIgnored: () => false });
		assert.equal(taken.ok, false);
		assert.equal(fs.readFileSync(path.join(elsewhere, "taken.json"), "utf8"), "x");
	});

	it("a path that reaches into the repository through a symlink is still inside", { skip: process.platform === "win32" }, async (t) => {
		const repo = await makeTempDir(t);
		const elsewhere = await makeTempDir(t);
		fs.symlinkSync(repo, path.join(elsewhere, "link"));
		assert.equal(checkRawOutPath(path.join(elsewhere, "link", "raw.json"), { repoRoot: repo, isIgnored: () => false }).ok, false);
	});

	it("the real repository root is refused with the default git lookup (this file is not in an ignored directory)", () => {
		const r = checkRawOutPath(path.join(import.meta.dirname, "..", "raw-probe-output.json"), { isIgnored: () => false });
		assert.equal(r.ok, false);
	});

	it("main refuses BEFORE any request is sent (the refresh would rotate the token), exit 1", async (t) => {
		const api = await startApiDouble(t);
		api.route("POST /oauth2/token", tokenIssuer());
		api.route("GET /api/getstationsdata", stationsOk());
		const repo = await makeTempDir(t);
		const r = await quiet(() => main(["--raw-out", path.join(repo, "raw.json")], env, { baseUrl: api.baseUrl, repoRoot: repo, isIgnored: () => false, runSecretspec: () => ({ ok: true }) }));
		assert.equal(r.code, 1);
		assert.match(r.text, /refused/);
		assert.equal(api.requests.length, 0);
		assert.equal(fs.existsSync(path.join(repo, "raw.json")), false);
	});

	it("main writes the file 0600 outside the repo and prints the personal-data warning", { skip: process.platform === "win32" }, async (t) => {
		const api = await startApiDouble(t);
		api.route("POST /oauth2/token", tokenIssuer());
		api.route("GET /api/getstationsdata", stationsOk());
		api.route("POST /api/getstationsdata", stationsOk());
		const repo = await makeTempDir(t);
		const out = await makeTempDir(t);
		const file = path.join(out, "raw.json");
		const r = await quiet(() => main(["--raw-out", file], env, { baseUrl: api.baseUrl, repoRoot: repo, isIgnored: () => false, runSecretspec: () => ({ ok: true }) }));
		assert.equal(r.code, 0, r.text);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.match(r.text, /WARNING.*personal data.*DELETE/s);
	});
});

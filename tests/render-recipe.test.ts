// Tests for scripts/render-with-codex.py. No real Codex call is made: a fake
// "codex" (a small python3 script) is passed through --codex-bin and records what
// the real one would have seen (CODEX_HOME contents, working directory, stdin).
// The fake login file is a dummy; no real credentials are involved.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const SCRIPT = resolve(import.meta.dirname, "../scripts/render-with-codex.py");
const sandbox = mkdtempSync(join(tmpdir(), "render-recipe-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

// FAKE_MODE: ok (default) | badpng | slow | fail | rewrite_auth
const FAKE_CODEX = `#!/usr/bin/env python3
import os, sys, struct, zlib, time, json
if sys.argv[1:] == ["--version"]:
    print("codex-cli 0.0.0-fake"); sys.exit(0)
args = sys.argv[1:]
work = args[args.index("-C") + 1]
prompt = sys.stdin.read()
home = os.environ["CODEX_HOME"]
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps({
        "home": home,
        "home_entries": sorted(os.listdir(home)),
        "home_auth_is_symlink": os.path.islink(home + "/auth.json"),
        "work_entries_at_start": sorted(os.listdir(work)),
        "cwd_is_work": os.path.realpath(os.getcwd()) == os.path.realpath(work), "work": work, "prompt": prompt, "pid": os.getpid(),
    }) + "\\n")
mode = os.environ.get("FAKE_MODE", "ok")
if mode == "slow":
    time.sleep(60)
if mode == "fail":
    print("boom", file=sys.stderr); sys.exit(3)
if mode == "rewrite_auth":
    os.unlink(home + "/auth.json")
    open(home + "/auth.json", "w").write("refreshed-dummy")
def png(w, h):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    raw = b"".join(b"\\x00" + b"\\x10\\x20\\x30" * w for _ in range(h))
    return b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
if "./result.png" in prompt:
    data = png(32, 32)
    if mode == "badpng":
        data = data[:-20]
    open(work + "/result.png", "wb").write(data)
else:
    open(work + "/result.svg", "w").write('<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="18" fill="#222"/></svg>')
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}))
`;

const bin = join(sandbox, "fake-codex");
writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
const auth = join(sandbox, "auth.json");
writeFileSync(auth, "dummy-not-a-credential", { mode: 0o600 });

const JOBS = [
	{ name: "icon", kind: "png", w: 32, h: 32, prompt: "A flat round weather sensor icon." },
	{ name: "tile", kind: "svg", w: 144, h: 144, prompt: "A dark tile with the number 21.4." },
];

let counter = 0;
function scenario(jobs: unknown[] = JOBS) {
	const dir = join(sandbox, `s${counter++}`);
	mkdirSync(dir);
	const jobsFile = join(dir, "jobs.json");
	writeFileSync(jobsFile, JSON.stringify(jobs));
	const out = join(dir, "out");
	const log = join(dir, "fake.log");
	const base = ["-I", SCRIPT, "--codex-bin", bin, "--auth-file", auth];
	const env = { ...process.env, FAKE_LOG: log };
	const run = (extra: string[] = [], mode = "ok") =>
		spawnSync("python3", [...base, ...extra, jobsFile, out], { env: { ...env, FAKE_MODE: mode }, encoding: "utf8", timeout: 60_000 });
	// The fake codex appends to this file while the test polls it (waitFor): a half-written last line
	// is not a call yet. Only newline-terminated lines count. (On a macOS CI runner the read once landed
	// mid-write and JSON.parse threw "Unexpected end of JSON input".)
	const calls = () => {
		if (!existsSync(log)) return [];
		const raw = readFileSync(log, "utf8");
		const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
		return complete.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
	};
	return { dir, jobsFile, out, log, base, env, run, calls };
}

describe("render-with-codex.py", () => {
	it("the call log helper ignores a half-written last line instead of throwing (macOS CI flake)", () => {
		const s = scenario();
		writeFileSync(s.log, '{"call":1}\n{"call":2}\n{"call":');
		assert.deepEqual(s.calls(), [{ call: 1 }, { call: 2 }]);
		writeFileSync(s.log, '{"call":1}\n{"call":2}\n{"call":3}\n');
		assert.equal(s.calls().length, 3, "a finished line counts as soon as its newline is there");
		writeFileSync(s.log, "");
		assert.deepEqual(s.calls(), []);
	});

	it("renders, validates and publishes atomically, then skips on the second run", () => {
		const s = scenario();
		const r1 = s.run();
		assert.equal(r1.status, 0, r1.stderr);
		assert.match(r1.stderr, /2 ok, 0 skip, 0 error, 0 cleanup, 0 left/);
		assert.ok(existsSync(join(s.out, "icon.png")));
		assert.ok(existsSync(join(s.out, "tile.svg")));
		const meta = JSON.parse(readFileSync(join(s.out, "icon.meta.json"), "utf8"));
		assert.equal(meta.codex, "codex-cli 0.0.0-fake");
		assert.deepEqual(meta.usage, { input_tokens: 10, output_tokens: 2 });
		assert.deepEqual(readdirSync(s.out).filter((f) => f.includes(".tmp.") || f.startsWith("codexlog.")), []);
		const r2 = s.run();
		assert.equal(r2.status, 0, r2.stderr);
		assert.match(r2.stderr, /0 ok, 2 skip, 0 error, 0 cleanup, 0 left/);
		assert.equal(s.calls().length, 2, "second run must not call codex");
	});

	it("shows a progress line with n/N, rate, ETA and elapsed", () => {
		const r = scenario().run();
		assert.match(r.stderr, /\d+\/2 {2}[\d.]+\/min {2}ETA \S+ {2}elapsed \d+:\d\d/);
	});

	it("isolates codex: throwaway home with only the auth symlink, empty work dir, both deleted", () => {
		const s = scenario();
		s.run();
		for (const c of s.calls()) {
			assert.deepEqual(c.home_entries, ["auth.json"]);
			assert.equal(c.home_auth_is_symlink, true);
			assert.deepEqual(c.work_entries_at_start, []);
			assert.equal(c.cwd_is_work, true);
			assert.ok(!existsSync(c.home), "throwaway CODEX_HOME must be removed");
			assert.ok(!existsSync(c.work), "work dir must be removed");
		}
		assert.equal(readFileSync(auth, "utf8"), "dummy-not-a-credential");
	});

	it("appends the format rules and the no-logo statement to the prompt", () => {
		const s = scenario();
		s.run();
		const [png, svg] = s.calls().map((c) => c.prompt);
		assert.match(png, /image generation tool/);
		assert.match(png, /no logos or trademarks/);
		assert.match(svg, /viewBox="0 0 144 144"/);
		assert.match(svg, /No logos or trademarks/);
	});

	it("rejects invalid output (truncated PNG) as an error, exit 1, and publishes nothing", () => {
		const s = scenario();
		const r = s.run([], "badpng");
		assert.equal(r.status, 1);
		assert.match(r.stderr, /ERROR icon: output rejected/);
		assert.match(r.stderr, /1 ok, 0 skip, 1 error/);
		assert.ok(!existsSync(join(s.out, "icon.png")));
	});

	it("counts a failing codex as error and keeps going", () => {
		const s = scenario();
		const r = s.run([], "fail");
		assert.equal(r.status, 1);
		assert.match(r.stderr, /codex exit=3/);
		assert.match(r.stderr, /0 ok, 0 skip, 2 error/);
	});

	it("regenerates an output that exists but does not validate, and sweeps temp leftovers (CLEANUP)", () => {
		const s = scenario();
		s.run();
		writeFileSync(join(s.out, "icon.png"), "not a png");
		writeFileSync(join(s.out, "tile.svg.tmp.99999"), "half written");
		const r = s.run();
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stderr, /1 ok, 1 skip, 0 error, 1 cleanup, 0 left/);
		assert.ok(!existsSync(join(s.out, "tile.svg.tmp.99999")));
	});

	it("refuses prompts with secrets, personal data, brands or logo requests before sending anything", () => {
		const bad = [
			"use refresh_token abc",
			`mail me at someone${"@"}example.org`,
			"device 00:00:5e:00:53:01",
			"host 192.0.2.7",
			`in the style of the ${"Net"}${"atmo"} station`,
			"please add the company logo",
			"looks like a famous brand",
		];
		for (const prompt of bad) {
			const s = scenario([{ name: "x", kind: "png", w: 8, h: 8, prompt }]);
			const r = s.run();
			assert.equal(r.status, 2, `${prompt}: ${r.stderr}`);
			assert.match(r.stderr, /config error: x:/);
			assert.equal(s.calls().length, 0);
		}
	});

	it("allows the explicit negation 'no logos'", () => {
		const s = scenario([{ name: "x", kind: "svg", w: 144, h: 144, prompt: "A tile. No logos, no text." }]);
		assert.equal(s.run().status, 0);
	});

	it("exits 75 while another run holds the lock, and --status reports it", async () => {
		const s = scenario();
		const slow = spawn("python3", [...s.base, s.jobsFile, s.out], { env: { ...s.env, FAKE_MODE: "slow" }, stdio: "ignore" });
		try {
			await waitFor(() => s.calls().length > 0);
			const second = s.run();
			assert.equal(second.status, 75);
			assert.match(second.stderr, /already running: pid=\d+/);
			const status = s.run(["--status"]);
			assert.equal(status.status, 75);
		} finally {
			slow.kill("SIGTERM"); // the script forwards it to its codex child group
			await onExit(slow);
		}
		assert.match(s.run(["--status"]).stdout, /not running/);
	});

	it("aborts fast on SIGTERM: exit 143, child process group killed, nothing published", async () => {
		const s = scenario();
		const p = spawn("python3", [...s.base, s.jobsFile, s.out], { env: { ...s.env, FAKE_MODE: "slow" }, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		p.stderr?.on("data", (d) => {
			stderr += d;
		});
		await waitFor(() => s.calls().length > 0);
		const childPid = s.calls()[0].pid as number;
		const t0 = Date.now();
		p.kill("SIGTERM");
		const code = await onExit(p);
		assert.equal(code, 143, stderr);
		assert.ok(Date.now() - t0 < 10_000, "abort must not wait for the job timeout");
		assert.match(stderr, /aborted/);
		assert.throws(() => process.kill(childPid, 0), "fake codex must be dead");
		assert.deepEqual(readdirSync(s.out).filter((f) => /\.(png|svg)$/.test(f)), []);
	});

	it("copies a login file that codex rewrote in the throwaway home back to the original", () => {
		const s = scenario([JOBS[1]]);
		const a2 = join(s.dir, "auth2.json");
		writeFileSync(a2, "before", { mode: 0o600 });
		const r = spawnSync("python3", ["-I", SCRIPT, "--codex-bin", bin, "--auth-file", a2, s.jobsFile, s.out], {
			env: { ...s.env, FAKE_MODE: "rewrite_auth" }, encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		assert.equal(readFileSync(a2, "utf8"), "refreshed-dummy");
		assert.ok(!lstatSync(a2).isSymbolicLink());
		assert.equal(lstatSync(a2).mode & 0o777, 0o600);
	});

	it("exits 2 with a clear message when the login file is missing", () => {
		const s = scenario();
		const r = spawnSync("python3", ["-I", SCRIPT, "--codex-bin", bin, "--auth-file", join(s.dir, "nope.json"), s.jobsFile, s.out], { encoding: "utf8" });
		assert.equal(r.status, 2);
		assert.match(r.stderr, /codex login/);
	});
});

describe("shipped scripts/render-jobs.json", () => {
	const jobs = JSON.parse(readFileSync(resolve(import.meta.dirname, "../scripts/render-jobs.json"), "utf8"));
	it("is accepted by the prompt guard and has the expected jobs", () => {
		// Loading through the script exercises load_jobs() including guard_prompt().
		const s = scenario(jobs);
		const r = s.run(["--only", "tile-temperature"]);
		assert.equal(r.status, 0, r.stderr);
		const names = jobs.map((j: { name: string }) => j.name);
		for (const n of ["plugin-icon-a", "tile-temperature", "tile-humidity", "tile-co2", "tile-wind"]) assert.ok(names.includes(n), n);
	});
	it("never mentions the service brand or other manufacturers", () => {
		const text = readFileSync(resolve(import.meta.dirname, "../scripts/render-jobs.json"), "utf8");
		assert.doesNotMatch(text, new RegExp(`${"Net"}atmo|${"Elg"}ato|${"Cors"}air|Stream ?Deck`, "i"));
	});
});

function onExit(p: ChildProcess): Promise<number | null> {
	return new Promise((res) => {
		if (p.exitCode !== null || p.signalCode !== null) return res(p.exitCode);
		p.once("exit", (code) => res(code));
	});
}

async function waitFor(cond: () => boolean, ms = 15_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out waiting for condition");
}

describe("shipped plugin artwork", () => {
	const magick = spawnSync("magick", ["-version"], { encoding: "utf8" });
	it("passes scripts/finalize-assets.py --check (sizes, opacity, white-on-transparent)", { skip: magick.status !== 0 && "ImageMagick not installed" }, () => {
		const r = spawnSync("python3", ["-I", resolve(import.meta.dirname, "../scripts/finalize-assets.py"), "--check"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
	});
	it("keeps the Codex-made preview SVGs free of active content", () => {
		const dir = resolve(import.meta.dirname, "../assets/final/previews");
		for (const f of readdirSync(dir).filter((n) => n.endsWith(".svg"))) {
			const text = readFileSync(join(dir, f), "utf8");
			assert.doesNotMatch(text, /<script|<image|<foreignObject|href=|@import|url\(\s*["']?http/i, f);
		}
	});
});

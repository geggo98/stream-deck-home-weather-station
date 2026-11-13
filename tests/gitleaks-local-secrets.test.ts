/**
 * scripts/gitleaks-local-secrets.py must make gitleaks recognise the REAL values of the local,
 * git-ignored .env.local in every spelling, in staged content and in history, without ever printing
 * them. A scanner that cannot match reports the same as a clean tree, so each case plants a value
 * first (the "detects" cases are the proof that the clean case can fail).
 *
 * The fake secrets are assembled at run time from parts so this file itself contains no token-shaped
 * literal for gitleaks to flag. Needs the gitleaks binary (devenv provides it; GITLEAKS_BIN overrides).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const script = resolve(import.meta.dirname, "..", "scripts", "gitleaks-local-secrets.py");
const gitleaks = process.env.GITLEAKS_BIN ?? spawnSync("sh", ["-c", "command -v gitleaks"], { encoding: "utf8" }).stdout.trim();
const available = gitleaks !== "";

const SECRET = ["zq8W", "m3Kf", "Pv1x", "Lr7T", "n2Bd"].join("");
const TOKEN = ["a1b2c3d4", "|", "e5f6a7b8", "c9d0e1f2"].join("");

function git(cwd: string, ...args: string[]) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

function makeRepo(envFile: string | undefined): string {
	const dir = mkdtempSync(join(tmpdir(), "glls-"));
	git(dir, "init", "-q", ".");
	git(dir, "config", "user.email", "t@users.noreply.github.com");
	git(dir, "config", "user.name", "t");
	writeFileSync(join(dir, ".gitignore"), ".env.local\n");
	if (envFile !== undefined) writeFileSync(join(dir, ".env.local"), envFile);
	git(dir, "add", ".gitignore");
	git(dir, "commit", "-qm", "init");
	return dir;
}

function run(dir: string, mode: "--staged" | "--history") {
	const r = spawnSync("python3", ["-I", script, mode], { cwd: dir, encoding: "utf8", env: { ...process.env, GITLEAKS_BIN: gitleaks } });
	return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const ENV = `NETATMO_CLIENT_SECRET=${SECRET}\nNETATMO_REFRESH_TOKEN=${TOKEN}\nSHORT=abc\n# comment\n`;

describe("gitleaks with local secret values", { skip: available ? false : "gitleaks binary not found (enter devenv shell or set GITLEAKS_BIN)" }, () => {
	const spellings: Array<[string, string]> = [
		["raw", `x = "${SECRET}"\n`],
		["URL-encoded token", `q=${encodeURIComponent(TOKEN)}\n`],
		["base64 secret", `v=${Buffer.from(SECRET).toString("base64")}\n`],
		["JSON-escaped token", `${JSON.stringify({ t: TOKEN })}\n`],
	];

	for (const [name, content] of spellings) {
		it(`detects the ${name} spelling in staged content and never prints the value`, () => {
			const dir = makeRepo(ENV);
			try {
				writeFileSync(join(dir, "leak.txt"), content);
				git(dir, "add", "leak.txt");
				const { status, output } = run(dir, "--staged");
				assert.equal(status, 1, output);
				assert.match(output, /leaks found: [1-9]/); // two spellings can match the same text
				for (const value of [SECRET, TOKEN, encodeURIComponent(TOKEN), Buffer.from(SECRET).toString("base64")]) {
					assert.ok(!output.includes(value), "the secret value must not appear in the output");
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("passes clean content and reports how many local values it loaded (short values are ignored)", () => {
		const dir = makeRepo(ENV);
		try {
			writeFileSync(join(dir, "clean.txt"), "nothing to see\n");
			git(dir, "add", "clean.txt");
			const { status, output } = run(dir, "--staged");
			assert.equal(status, 0, output);
			assert.match(output, /2 local value\(s\)/, "SHORT=abc is below the minimum length and must not become a rule");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("finds a value that was committed earlier (history mode)", () => {
		const dir = makeRepo(ENV);
		try {
			writeFileSync(join(dir, "old.txt"), `token=${SECRET}\n`);
			git(dir, "add", "old.txt");
			git(dir, "commit", "-qm", "oops");
			git(dir, "rm", "-q", "old.txt");
			git(dir, "commit", "-qm", "remove it again");
			assert.equal(run(dir, "--staged").status, 0, "nothing is staged any more");
			const { status, output } = run(dir, "--history");
			assert.equal(status, 1, output);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("without a dotenv file only the generic rules run and the run says so", () => {
		const dir = makeRepo(undefined);
		try {
			const { status, output } = run(dir, "--history");
			assert.equal(status, 0, output);
			assert.match(output, /exact values not checked/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves no temporary config behind", () => {
		const before = readdirSync(tmpdir()).filter((n) => n.startsWith("gitleaks-local-")).length;
		const dir = makeRepo(ENV);
		try {
			writeFileSync(join(dir, "leak.txt"), `x=${SECRET}\n`);
			git(dir, "add", "leak.txt");
			run(dir, "--staged");
			assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith("gitleaks-local-")).length, before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * The shape layer: .gitleaks-shapes.json (calibrated on the dotenv values by --calibrate) makes
 * gitleaks report a NEW string of the same character classes, lengths and separators with enough
 * entropy, although that exact value was never in .env.local (a refresh token rotates on every use).
 * All values are generated at run time by a seeded generator, so no token-shaped literal is in this file.
 */
function generator(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function random(seed: number, alphabet: string, length: number): string {
	const next = generator(seed);
	return Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
}
// alphabets built from ranges: a spelled-out alphabet is itself a "long base64-looking string" for the hygiene scan
const range = (a: string, b: string) => Array.from({ length: b.charCodeAt(0) - a.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(a.charCodeAt(0) + i)).join("");
const HEX = range("0", "9") + range("a", "f");
const ALNUM = range("0", "9") + range("A", "Z") + range("a", "z");
const entropy = (s: string) => {
	const counts = new Map<string, number>();
	for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
	return -[...counts.values()].reduce((sum, n) => sum + (n / s.length) * Math.log2(n / s.length), 0);
};

const id1 = random(1, HEX, 24);
const secret1 = random(2, ALNUM, 43);
const token1 = `${random(3, HEX, 24)}|${random(4, HEX, 32)}`;
const calibratedEnv = `FAKE_CLIENT_ID=${id1}\nFAKE_CLIENT_SECRET=${secret1}\nFAKE_REFRESH_TOKEN=${token1}\n`;

function calibratedRepo(): string {
	const dir = makeRepo(calibratedEnv);
	const r = spawnSync("python3", ["-I", script, "--calibrate"], { cwd: dir, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	// the exact values are removed again: only the SHAPES may catch what follows (the CI situation / a rotated token)
	rmSync(join(dir, ".env.local"));
	return dir;
}

function stagedFinding(dir: string, file: string, content: string) {
	writeFileSync(join(dir, file), content);
	git(dir, "add", "-f", file);
	const result = run(dir, "--staged");
	git(dir, "rm", "-qf", "--cached", file);
	return result;
}

describe("gitleaks secret shapes", { skip: available ? false : "gitleaks binary not found (enter devenv shell or set GITLEAKS_BIN)" }, () => {
	it("calibration stores shapes and thresholds, never a value", () => {
		const dir = calibratedRepo();
		try {
			const profile = readFileSync(join(dir, ".gitleaks-shapes.json"), "utf8");
			for (const value of [id1, secret1, token1, token1.split("|")[0]!, token1.split("|")[1]!]) {
				assert.ok(!profile.includes(value), "the profile must not contain a secret value");
			}
			const parsed = JSON.parse(profile) as { shapes: Array<{ name: string; minEntropy: number; parts: Array<{ min: number; max: number }> }> };
			assert.equal(parsed.shapes.length, 3);
			const byName = Object.fromEntries(parsed.shapes.map((s) => [s.name, s]));
			assert.deepEqual(byName["FAKE_CLIENT_ID"]!.parts, [{ charset: "hex-lower", min: 24, max: 24 }], "hex identifiers keep their exact length");
			assert.ok(byName["FAKE_CLIENT_SECRET"]!.parts[0]!.max - byName["FAKE_CLIENT_SECRET"]!.parts[0]!.min >= 4, "alphanumeric secrets get a tolerance");
			assert.ok(byName["FAKE_CLIENT_ID"]!.minEntropy <= entropy(id1) - 0.4 && byName["FAKE_CLIENT_ID"]!.minEntropy >= 2.8, "threshold sits below the measured entropy");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const rotated = [
		["a rotated refresh token", `refresh = ${random(11, HEX, 24)}|${random(12, HEX, 32)}\n`],
		["a new client id", `id: ${random(13, HEX, 24)}\n`],
		["a new client secret of a slightly different length", `s=${random(14, ALNUM, 45)}\n`],
		["a rotated refresh token in a URL (the pipe percent-encoded)", `https://example.invalid/cb?t=${random(17, HEX, 24)}%7C${random(18, HEX, 32)}&x=1\n`],
		["a token in the middle of prose", `see (${random(15, HEX, 24)}|${random(16, HEX, 32)}), it works\n`],
	] as const;
	for (const [name, content] of rotated) {
		it(`reports ${name} although the value was never in .env.local`, () => {
			const dir = calibratedRepo();
			try {
				const { status, output } = stagedFinding(dir, "note.txt", content);
				assert.equal(status, 1, output);
				assert.match(output, /leaks found: [1-9]/);
				assert.match(output, /3 secret shape\(s\)/);
				assert.match(output, /exact values not checked/, "no dotenv file: only the shapes ran");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	const harmless = [
		["a repeated character (low entropy)", `x=${"0".repeat(24)}\n`],
		["a short repeating pattern", `x=${"ab".repeat(12)}|${"cd".repeat(16)}\n`],
		["a 40-digit commit hash (longer than the shape)", `commit ${random(21, HEX, 40)}\n`],
		["25 hex digits (one too many)", `x=${random(22, HEX, 25)}\n`],
		["23 hex digits (one too few)", `x=${random(23, HEX, 23)}\n`],
		["the shape inside a longer alphanumeric run", `x=Z${random(24, HEX, 24)}Z\n`],
		["a UUID", `id=${[8, 4, 4, 4, 12].map((n, i) => random(30 + i, HEX, n)).join("-")}\n`],
		["a 43-digit hex string (not the alphanumeric shape: lower entropy)", `x=${random(25, HEX, 43)}\n`],
		["ordinary prose", "The quick brown fox jumps over the lazy dog, twice.\n"],
	] as const;
	for (const [name, content] of harmless) {
		it(`does not report ${name}`, () => {
			const dir = calibratedRepo();
			try {
				const { status, output } = stagedFinding(dir, "note.txt", content);
				assert.equal(status, 0, output);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("exempts lock files, where base64 digests look like random alphanumerics", () => {
		const dir = calibratedRepo();
		try {
			const digest = random(41, ALNUM, 44);
			assert.equal(stagedFinding(dir, "note.txt", `x=${digest}\n`).status, 1, "the same string elsewhere IS reported (proof the exemption is what saves the lock file)");
			assert.equal(stagedFinding(dir, "package-lock.json", `{"integrity": "sha512-${digest}"}\n`).status, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("an allow entry exempts exactly its path AND its value, nothing else", () => {
		const dir = calibratedRepo();
		try {
			const sample = random(51, HEX, 24);
			const profilePath = join(dir, ".gitleaks-shapes.json");
			const profile = JSON.parse(readFileSync(profilePath, "utf8"));
			profile.allow = [{ path: "tests/sample\\.test\\.ts$", regex: sample, reason: "synthetic sample of a scanner self-test" }];
			writeFileSync(profilePath, JSON.stringify(profile));
			mkdirSync(join(dir, "tests"));
			assert.equal(stagedFinding(dir, "tests/sample.test.ts", `x=${sample}\n`).status, 0, "listed path and listed value");
			assert.equal(stagedFinding(dir, "tests/other.test.ts", `x=${sample}\n`).status, 1, "the same value in another file");
			assert.equal(stagedFinding(dir, "tests/sample.test.ts", `x=${random(52, HEX, 24)}\n`).status, 1, "another value in the listed file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps manually added allow entries when it is calibrated again", () => {
		const dir = calibratedRepo();
		try {
			const profilePath = join(dir, ".gitleaks-shapes.json");
			const profile = JSON.parse(readFileSync(profilePath, "utf8"));
			profile.allow = [{ path: "a$", regex: "b", reason: "kept" }];
			writeFileSync(profilePath, JSON.stringify(profile));
			writeFileSync(join(dir, ".env.local"), calibratedEnv);
			assert.equal(spawnSync("python3", ["-I", script, "--calibrate"], { cwd: dir }).status, 0);
			assert.equal(JSON.parse(readFileSync(profilePath, "utf8")).allow[0].reason, "kept");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("the committed profile of this repository matches the shape of the real secrets' kinds and flags the sample secrets", () => {
		const profile = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", ".gitleaks-shapes.json"), "utf8")) as { shapes: unknown[]; allow: Array<{ reason: string }> };
		assert.ok(profile.shapes.length >= 1, "an empty profile would make the shape layer a silent no-op");
		for (const entry of profile.allow) assert.ok(entry.reason.length > 20, "every allow entry needs a real reason");
	});
});

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
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function run(dir: string, mode: "--staged" | "--history", ...extra: string[]) {
	const r = spawnSync("python3", ["-I", script, mode, ...extra], { cwd: dir, encoding: "utf8", env: { ...process.env, GITLEAKS_BIN: gitleaks } });
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
				// -v makes gitleaks print every finding: only then can "the value is absent" fail (without it gitleaks prints no findings at all)
				const { status, output } = run(dir, "--staged", "-v");
				assert.equal(status, 1, output);
				assert.match(output, /leaks found: [1-9]/); // two spellings can match the same text
				assert.match(output, /RuleID:\s+local-secret-/, "the findings ARE printed, so the absence of the value below means something");
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

function calibratedRepo(env: string = calibratedEnv): string {
	const dir = makeRepo(env);
	const r = spawnSync("python3", ["-I", script, "--calibrate"], { cwd: dir, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	// the exact values are removed again: only the SHAPES may catch what follows (the CI situation / a rotated token)
	rmSync(join(dir, ".env.local"));
	return dir;
}

function stagedFinding(dir: string, file: string, content: string, ...extra: string[]) {
	writeFileSync(join(dir, file), content);
	git(dir, "add", "-f", file);
	const result = run(dir, "--staged", ...extra);
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
});

const rulesIn = (output: string): string[] => [...output.matchAll(/RuleID:\s+(\S+)/g)].map((m) => m[1]!);
const alphabetOf = (charset: string): string => (charset === "hex-lower" ? HEX : charset === "hex-upper" ? HEX.toUpperCase() : ALNUM);

interface Shape {
	name: string;
	minEntropy: number;
	parts: Array<{ charset: string; min: number; max: number }>;
	separators: string[];
}

/** A fresh value of the shape (never a value of the real secret), with clearly more entropy than the threshold. */
function sampleOf(shape: Shape, seed: number): string {
	for (let attempt = 0; attempt < 200; attempt++) {
		const value = shape.parts
			.map((p, i) => random(seed + attempt * 7 + i, alphabetOf(p.charset), Math.round((p.min + p.max) / 2)) + (shape.separators[i] ?? ""))
			.join("");
		if (entropy(value) >= shape.minEntropy + 0.15) return value;
	}
	throw new Error(`no sample with enough entropy for ${shape.name}`);
}

describe("gitleaks secret shapes: the committed profile and its calibration", { skip: available ? false : "gitleaks binary not found (enter devenv shell or set GITLEAKS_BIN)" }, () => {
	const committed = resolve(import.meta.dirname, "..", ".gitleaks-shapes.json");

	it("the committed profile flags a fresh value of each of its shapes and passes a harmless sample", () => {
		const profile = JSON.parse(readFileSync(committed, "utf8")) as { shapes: Shape[]; allow: Array<{ reason: string }> };
		assert.ok(profile.shapes.length >= 3, "an empty profile would make the shape layer a silent no-op");
		for (const entry of profile.allow) assert.ok(entry.reason.length > 20, "every allow entry needs a real reason");
		const dir = makeRepo(undefined);
		try {
			cpSync(committed, join(dir, ".gitleaks-shapes.json"));
			cpSync(resolve(import.meta.dirname, "..", ".gitleaks.toml"), join(dir, ".gitleaks.toml"));
			profile.shapes.forEach((shape, i) => {
				const value = sampleOf(shape, 100 + i * 50);
				const { status, output } = stagedFinding(dir, "note.txt", `v: ${value}\n`, "-v");
				assert.equal(status, 1, `${shape.name}: a fresh value of the committed shape must be reported\n${output}`);
				assert.ok(rulesIn(output).includes(`secret-shape-${shape.name}`), `${shape.name}: rules that fired: ${rulesIn(output).join(", ")}`);
				assert.ok(!output.includes(value));
			});
			assert.equal(stagedFinding(dir, "note.txt", "nothing to see, a harmless sentence.\n").status, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a profile whose entropy threshold no string of the shape can reach (a silent no-op)", () => {
		const dir = calibratedRepo();
		try {
			const profilePath = join(dir, ".gitleaks-shapes.json");
			const profile = JSON.parse(readFileSync(profilePath, "utf8"));
			profile.shapes[0].minEntropy = 9.5;
			writeFileSync(profilePath, JSON.stringify(profile));
			writeFileSync(join(dir, "n.txt"), "x\n");
			git(dir, "add", "n.txt");
			const { status, output } = run(dir, "--staged");
			assert.equal(status, 1, output);
			assert.match(output, /no string of that shape can have more than/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a threshold below the entropy floor and an allow entry without a reason", () => {
		for (const [mutate, message] of [
			[(p: any) => void (p.shapes[0].minEntropy = 1.0), /invalid shape profile/],
			[(p: any) => void (p.allow = [{ path: "a$", regex: "b" }]), /an allow entry needs path, regex and reason/],
		] as const) {
			const dir = calibratedRepo();
			try {
				const profilePath = join(dir, ".gitleaks-shapes.json");
				const profile = JSON.parse(readFileSync(profilePath, "utf8"));
				mutate(profile);
				writeFileSync(profilePath, JSON.stringify(profile));
				const { status, output } = run(dir, "--staged");
				assert.notEqual(status, 0, output);
				assert.match(output, message);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("calibrates the entropy margin, the alphanumeric tolerance and the floor exactly", () => {
		const dir = calibratedRepo();
		try {
			const parsed = JSON.parse(readFileSync(join(dir, ".gitleaks-shapes.json"), "utf8")) as { shapes: Shape[] };
			const byName = Object.fromEntries(parsed.shapes.map((x) => [x.name, x]));
			const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) <= 0.0051, `${what}: ${actual} vs ${expected}`);
			near(byName["FAKE_CLIENT_ID"]!.minEntropy, entropy(id1) - 0.5, "hex entropy = measured - 0.5");
			near(byName["FAKE_CLIENT_SECRET"]!.minEntropy, entropy(secret1) - 0.5, "alnum entropy = measured - 0.5");
			near(byName["FAKE_REFRESH_TOKEN"]!.minEntropy, entropy(token1) - 0.5, "token entropy = measured - 0.5");
			assert.deepEqual(byName["FAKE_CLIENT_SECRET"]!.parts, [{ charset: "alnum", min: 43 - 4, max: 43 + 4 }], "43 characters: +-10 % is 4");
			assert.deepEqual(byName["FAKE_REFRESH_TOKEN"]!.parts, [{ charset: "hex-lower", min: 24, max: 24 }, { charset: "hex-lower", min: 32, max: 32 }]);
			assert.deepEqual(byName["FAKE_REFRESH_TOKEN"]!.separators, ["|"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const lowDir = calibratedRepo(`LOW=${"0a".repeat(12)}\n`);
		try {
			const low = JSON.parse(readFileSync(join(lowDir, ".gitleaks-shapes.json"), "utf8")) as { shapes: Shape[] };
			assert.equal(low.shapes[0]!.minEntropy, 2.8, "a low-entropy value never lowers the threshold below the floor");
		} finally {
			rmSync(lowDir, { recursive: true, force: true });
		}
	});

	it("calibrates only on values of 16 characters or more, and loads exact values of 8 characters or more", () => {
		const fifteen = calibratedRepo(`A=${random(61, HEX, 15)}\n`);
		const sixteen = calibratedRepo(`A=${random(62, HEX, 16)}\n`);
		try {
			assert.equal(JSON.parse(readFileSync(join(fifteen, ".gitleaks-shapes.json"), "utf8")).shapes.length, 0);
			assert.equal(JSON.parse(readFileSync(join(sixteen, ".gitleaks-shapes.json"), "utf8")).shapes.length, 1);
		} finally {
			rmSync(fifteen, { recursive: true, force: true });
			rmSync(sixteen, { recursive: true, force: true });
		}
		for (const [value, expected] of [["1234567", /no usable values/], ["12345678", /1 local value\(s\)/]] as const) {
			const dir = makeRepo(`B=${value}\n`);
			try {
				assert.match(run(dir, "--staged").output, expected, `${value.length} characters`);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});
});

describe("gitleaks secret shapes: separators, spellings and exemptions", { skip: available ? false : "gitleaks binary not found (enter devenv shell or set GITLEAKS_BIN)" }, () => {
	// no 24-hex client id in this calibration: the 24-hex half of the token cannot match on its own
	const tokenOnlyEnv = `FAKE_REFRESH_TOKEN=${token1}\n`;
	const halves = (seed: number) => [random(seed, HEX, 24), random(seed + 1, HEX, 32)] as const;

	const forms: Array<[string, (a: string, b: string) => string]> = [
		["the pipe", (a, b) => `t=${a}|${b}\n`],
		["an upper-case percent-encoded pipe (%7C)", (a, b) => `https://example.invalid/cb?t=${a}%7C${b}&x=1\n`],
		["a lower-case percent-encoded pipe (%7c)", (a, b) => `https://example.invalid/cb?t=${a}%7c${b}&x=1\n`],
		["prose around the token", (a, b) => `see (${a}|${b}), it works\n`],
	];
	for (const [name, make] of forms) {
		it(`the refresh-token shape alone reports ${name}`, () => {
			const dir = calibratedRepo(tokenOnlyEnv);
			try {
				const [a, b] = halves(70);
				const { status, output } = stagedFinding(dir, "note.txt", make(a, b), "-v");
				assert.equal(status, 1, output);
				assert.deepEqual([...new Set(rulesIn(output))], ["secret-shape-FAKE_REFRESH_TOKEN"], "only the token shape fired");
				assert.match(output, /1 secret shape\(s\)/);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("the shape regex accepts the separator literally and percent-encoded in both cases (gitleaks may decode %7C itself, so the regex is checked directly)", () => {
		const py = [
			"import importlib.util, json, sys",
			"spec = importlib.util.spec_from_file_location('g', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
			"print(m.shape_regex(m.derive_shape('T', sys.argv[2])))",
		].join("\n");
		const r = spawnSync("python3", ["-I", "-c", py, script, token1], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const re = new RegExp(r.stdout.trim().replace(/\\x\{([0-9A-F]+)\}/g, "\\u{$1}"), "u"); // RE2 \x{7C} is \u{7C} in JS
		const [a, b] = halves(95);
		for (const sep of ["|", "%7C", "%7c"]) assert.ok(re.test(`x=${a}${sep}${b}&`), sep);
		for (const sep of ["%7D", "%7", "/", ""]) assert.ok(!re.test(`x=${a}${sep}${b}&`), `not ${sep}`);
	});

	it("a rotated token in a URL is reported by the token shape (and not only by the client id shape)", () => {
		const dir = calibratedRepo();
		try {
			const [a, b] = halves(80);
			const { output } = stagedFinding(dir, "note.txt", `https://example.invalid/cb?t=${a}%7C${b}&x=1\n`, "-v");
			assert.ok(rulesIn(output).includes("secret-shape-FAKE_REFRESH_TOKEN"), rulesIn(output).join(", "));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports the exact spellings that need their own rule: form-encoded and base64url", () => {
		const ruleOf = (spelling: string) => ["local", "secret", "PLAIN_VAL", spelling].join("-");
		const value = "a b??>>??>>"; // a space, '?' and '>' give '+', '%3F' and the url-safe base64 alphabet
		const dir = makeRepo(`PLAIN_VAL=${value}\n`);
		try {
			const formEncoded = encodeURIComponent(value).replace(/%20/g, "+");
			const b64url = Buffer.from(value).toString("base64url");
			assert.notEqual(Buffer.from(value).toString("base64"), b64url, "the case must tell the two base64 spellings apart");
			const form = stagedFinding(dir, "form.txt", `q=${formEncoded}\n`, "-v");
			assert.ok(rulesIn(form.output).includes(ruleOf("form-encoded")), rulesIn(form.output).join(", "));
			const url = stagedFinding(dir, "url.txt", `v=${b64url}\n`, "-v");
			assert.ok(rulesIn(url.output).includes(ruleOf("base64url")), rulesIn(url.output).join(", "));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exempts every calibrated exempt path, not only the npm lock file", () => {
		const dir = calibratedRepo();
		try {
			const digest = random(91, ALNUM, 44);
			assert.equal(stagedFinding(dir, "note.txt", `x=${digest}\n`).status, 1, "reported elsewhere");
			mkdirSync(join(dir, "ui", "vendor"), { recursive: true });
			for (const file of ["devenv.lock", "ui/vendor/x.js", "bundle.js.map"]) assert.equal(stagedFinding(dir, file, `x="${digest}"\n`).status, 0, file);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// CSP and SRI hashes are base64 of a digest: they look like a random alphanumeric client secret
	describe("sha256-/sha384-/sha512- hashes are not secrets", () => {
		const hash = (seed: number, length: number) => random(seed, ALNUM, length) + "=";
		const cases: Array<[string, string, string]> = [
			["a CSP hash", "csp.html", `<meta http-equiv="Content-Security-Policy" content="script-src 'sha256-${hash(101, 43)}'">\n`],
			["an SRI attribute", "sri.html", `<script src="x.js" integrity="sha384-${hash(102, 63)}" crossorigin="anonymous"></script>\n`],
			["an SRI hash in a minified JS line", "app.min.js", `!function(){var e=document.createElement("script");e.integrity="sha512-${hash(103, 87)}",e.crossOrigin="anonymous"}();\n`],
		];
		for (const [name, file, content] of cases) {
			it(`passes ${name}`, () => {
				const dir = calibratedRepo();
				try {
					assert.equal(stagedFinding(dir, file, content).status, 0, content);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			});
		}

		it("still reports the same 44 characters without the hash prefix (proof that the prefix is the exemption)", () => {
			const dir = calibratedRepo();
			try {
				assert.equal(stagedFinding(dir, "app.min.js", `!function(){var e="${random(104, ALNUM, 44)}";}();\n`).status, 1);
				assert.equal(stagedFinding(dir, "csp.html", `content="script-src 'sha255-${random(105, ALNUM, 43)}='"\n`).status, 1, "sha255 is no hash prefix");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("documents the remaining limits next to the mechanism: a standalone 24-hex id is reported, upper-case hex is not", () => {
			const dir = calibratedRepo();
			try {
				const id = random(106, HEX, 24);
				assert.equal(stagedFinding(dir, "ids.txt", `home_id: ${id}\n`).status, 1, "known false positive: an object id");
				assert.equal(stagedFinding(dir, "ids.txt", `home_id: ${id.toUpperCase()}\n`).status, 0, "known false negative: upper-case hex");
				const doc = readFileSync(script, "utf8");
				assert.match(doc, /False positive: a standalone 24-hex string/);
				assert.match(doc, /False negative: hex is calibrated in lower case only/);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

describe("gitleaks-local-secrets.py removes its temporary config when it is stopped by a signal", { skip: available ? false : "gitleaks binary not found (enter devenv shell or set GITLEAKS_BIN)" }, () => {
	for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
		it(`${signal}: exit ${code}, no config left behind`, async () => {
			const dir = makeRepo(ENV);
			const marker = join(dir, "config-path");
			const fake = join(dir, "fake-gitleaks.sh");
			// records the --config path, then waits like a long scan (exec: the wrapper's kill reaches the sleeper itself)
			writeFileSync(fake, `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--config" ]; then shift; printf %s "$1" > "${marker}.tmp"; mv "${marker}.tmp" "${marker}"; fi; shift; done\nexec sleep 30\n`);
			chmodSync(fake, 0o755);
			const child = spawn("python3", ["-I", script, "--staged"], { cwd: dir, env: { ...process.env, GITLEAKS_BIN: fake }, stdio: "ignore" });
			const exited = new Promise<number | null>((done) => child.on("exit", (c) => done(c)));
			try {
				const deadline = Date.now() + 10_000;
				while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
				assert.ok(existsSync(marker), "the fake gitleaks was started");
				const config = readFileSync(marker, "utf8");
				assert.ok(existsSync(config), "the temporary config exists while gitleaks runs");
				child.kill(signal);
				assert.equal(await exited, code);
				assert.ok(!existsSync(config), "the temporary config (it holds the local secret values) is gone after the signal");
			} finally {
				child.kill("SIGKILL");
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});

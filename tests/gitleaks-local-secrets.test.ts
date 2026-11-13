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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
			assert.match(output, /only the generic rules run/);
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

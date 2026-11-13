/**
 * Supply-chain hygiene for GitHub Actions: every third-party `uses:` is pinned to a full
 * 40-hex commit SHA and carries a `# vX` version comment (Dependabot and pinact read it),
 * and every workflow declares `permissions`. The scan is validated first: a sample with
 * one bad and one good line must be judged correctly, and the real run must have seen
 * a plausible number of `uses:` lines, otherwise "no violations" would mean nothing.
 *
 * Local actions (`uses: ./...`) need no pin. Docker references are not used in this repo and
 * would fail the pin rule on purpose.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".github", "workflows");

const USES = /^\s*(?:-\s*)?uses:\s*(?<ref>\S+)(?<rest>.*)$/;
// uses: owner/repo[/path]@<40 hex>  # v1, v1.2 or v1.2.3 (optionally followed by more text)
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^\s+#\s*v\d+(?:\.\d+){0,2}\b/;

export function usesViolations(text: string, file: string): { uses: number; problems: string[] } {
	let uses = 0;
	const problems: string[] = [];
	text.split("\n").forEach((line, i) => {
		const m = USES.exec(line);
		if (!m?.groups) return;
		const { ref, rest } = m.groups as { ref: string; rest: string };
		if (ref.startsWith("./")) return;
		uses++;
		if (!PINNED.test(ref)) problems.push(`${file}:${i + 1} not pinned to a 40-hex commit SHA: ${ref}`);
		else if (!VERSION_COMMENT.test(rest)) problems.push(`${file}:${i + 1} pinned but no "# vX.Y.Z" comment: ${ref}`);
	});
	return { uses, problems };
}

export function hasPermissions(text: string): boolean {
	// `permissions: write-all` (or read-all) is a declaration, but it is the opposite of least privilege
	if (/^\s*permissions:\s*(?:write-all|read-all)\b/m.test(text)) return false;
	// top-level block, or one on every job (checked loosely: at least one `permissions:` key)
	return /^permissions:/m.test(text) || /^\s{4}permissions:/m.test(text);
}

/** Every `actions/checkout` step must say `persist-credentials: false` (no token left in .git/config). */
export function checkoutViolations(text: string, file: string): { checkouts: number; problems: string[] } {
	let checkouts = 0;
	const problems: string[] = [];
	const steps = text.split(/^\s*-\s+(?=name:|uses:)/m).slice(1);
	for (const step of steps) {
		if (!/uses:\s*actions\/checkout@/.test(step)) continue;
		checkouts++;
		if (!/^\s*persist-credentials:\s*false\s*$/m.test(step)) problems.push(`${file}: a checkout step without "persist-credentials: false"`);
	}
	return { checkouts, problems };
}

const sha = "0123456789abcdef".repeat(2) + "01234567";

test("scanner validation: pinned lines pass, unpinned and uncommented lines fail", () => {
	const sample = [
		`      - uses: actions/checkout@${sha} # v7.0.1`,
		`      - uses: actions/checkout@v4`,
		`      - uses: actions/checkout@main # v4`,
		`      - uses: actions/checkout@${sha}`,
		`        uses: ./local-action`,
	].join("\n");
	const r = usesViolations(sample, "sample.yml");
	assert.equal(r.uses, 4, "local actions are not counted");
	assert.equal(r.problems.length, 3, r.problems.join("\n"));
	assert.equal(hasPermissions("name: x\non: push\n"), false);
	assert.equal(hasPermissions("name: x\npermissions:\n  contents: read\n"), true);
	assert.equal(hasPermissions("name: x\npermissions: write-all\n"), false, "write-all is not a least-privilege declaration");
	assert.equal(hasPermissions("name: x\njobs:\n  a:\n    permissions: write-all\n"), false);
});

test("scanner validation: a checkout without persist-credentials: false is flagged", () => {
	const bad = `      - name: Checkout\n        uses: actions/checkout@${sha} # v7.0.1\n`;
	const good = `${bad}        with:\n          persist-credentials: false\n`;
	assert.equal(checkoutViolations(bad, "s.yml").problems.length, 1);
	assert.equal(checkoutViolations(good, "s.yml").checkouts, 1);
	assert.deepEqual(checkoutViolations(good, "s.yml").problems, []);
	// the flag of one step must not excuse the next one
	assert.equal(checkoutViolations(good + bad, "s.yml").problems.length, 1);
});

test("every checkout step in every workflow sets persist-credentials: false", () => {
	let checkouts = 0;
	const problems: string[] = [];
	for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
		const r = checkoutViolations(readFileSync(join(dir, f), "utf8"), `.github/workflows/${f}`);
		checkouts += r.checkouts;
		problems.push(...r.problems);
	}
	assert.ok(checkouts >= 4, `only ${checkouts} checkout steps seen, the scan may be blind`);
	assert.deepEqual(problems, []);
});

test("every workflow pins all actions to a commit SHA with a version comment and declares permissions", () => {
	const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
	assert.ok(files.length >= 2, `expected at least ci.yml and release.yml, found ${files.join(", ")}`);
	let total = 0;
	const problems: string[] = [];
	for (const f of files) {
		const text = readFileSync(join(dir, f), "utf8");
		const r = usesViolations(text, `.github/workflows/${f}`);
		total += r.uses;
		problems.push(...r.problems);
		if (!hasPermissions(text)) problems.push(`.github/workflows/${f}: no permissions block`);
		if (/\bpull_request_target\b/.test(text)) {
			problems.push(`.github/workflows/${f}: pull_request_target runs fork code with secrets; not allowed here`);
		}
	}
	assert.ok(total >= 5, `only ${total} uses: lines seen, the scan may be blind`);
	assert.deepEqual(problems, []);
});

// ---- the build tool itself is pinned, not only the actions ------------------------------------

/** Every `nix profile add|install <ref>` must name an exact 40-hex revision of the flake. */
export function nixInstallViolations(text: string, file: string): { installs: number; problems: string[] } {
	let installs = 0;
	const problems: string[] = [];
	text.split("\n").forEach((line, i) => {
		const m = /nix profile (?:add|install)\s+(?<ref>\S+)/.exec(line);
		if (!m?.groups) return;
		installs++;
		if (!/^github:[\w.-]+\/[\w.-]+\/[0-9a-f]{40}#[\w.-]+$/.test(m.groups.ref as string)) {
			problems.push(`${file}:${i + 1} installs from a floating reference: ${m.groups.ref}`);
		}
	});
	return { installs, problems };
}

test("scanner validation: a floating nixpkgs ref is rejected, a revision-pinned flake ref passes", () => {
	const bad = nixInstallViolations("        run: nix profile add nixpkgs#devenv\n", "s.yml");
	assert.equal(bad.installs, 1);
	assert.equal(bad.problems.length, 1);
	assert.equal(nixInstallViolations("run: nix profile add github:cachix/devenv/main#devenv", "s.yml").problems.length, 1);
	assert.deepEqual(nixInstallViolations(`run: nix profile add github:cachix/devenv/${sha}#devenv`, "s.yml").problems, []);
});

test("every workflow installs devenv from an exact revision, and CI and release use the same one", () => {
	const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
	let installs = 0;
	const problems: string[] = [];
	const refs = new Set<string>();
	for (const f of files) {
		const text = readFileSync(join(dir, f), "utf8");
		const r = nixInstallViolations(text, `.github/workflows/${f}`);
		installs += r.installs;
		problems.push(...r.problems);
		for (const m of text.matchAll(/nix profile (?:add|install)\s+(\S+)/g)) refs.add(m[1] as string);
	}
	assert.ok(installs >= 3, `only ${installs} install steps seen (ci.yml has two, release.yml one); the scan may be blind`);
	assert.deepEqual(problems, []);
	assert.equal(refs.size, 1, `workflows disagree on the devenv revision: ${[...refs].join(", ")}`);
});

/** The text of one top-level job of a workflow file (from `  name:` to the next job or the end). */
function job(text: string, name: string): string {
	const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, "m").exec(text);
	return m?.[1] ?? "";
}

test("release.yml: the build job has no write token, the upload job has no checkout and no npm", () => {
	const text = readFileSync(join(dir, "release.yml"), "utf8");
	const build = job(text, "build");
	const upload = job(text, "upload");
	assert.ok(build.length > 200, "build job not found");
	assert.ok(upload.length > 200, "upload job not found");
	assert.equal(job(text, "publish"), "", "the old combined publish job must stay split");
	// build: checks out the release tag, read-only, installs without running install scripts
	assert.match(build, /actions\/checkout@[0-9a-f]{40}/);
	assert.match(build, /ref:\s*\$\{\{\s*needs\.release-please\.outputs\.tag_name\s*\}\}/, "checkout must use the tag, not default HEAD");
	assert.match(build, /permissions:\s*\n\s+contents: read\b/);
	assert.doesNotMatch(build, /:\s*write\b/, "the job that runs npm must not hold any write permission");
	assert.match(build, /npm ci --ignore-scripts/);
	assert.doesNotMatch(build, /gh release/);
	assert.match(build, /actions\/upload-artifact@[0-9a-f]{40}/);
	// upload: the write token, the attestation, and nothing that executes repository or npm code
	assert.match(upload, /needs:\s*\[release-please,\s*build\]/);
	assert.match(upload, /contents: write/);
	assert.match(upload, /id-token: write/);
	assert.match(upload, /attestations: write/);
	assert.match(upload, /actions\/attest-build-provenance@[0-9a-f]{40}/);
	assert.match(upload, /actions\/download-artifact@[0-9a-f]{40}/);
	assert.match(upload, /gh release upload/);
	const code = upload.replace(/^\s*name:.*$/gm, "").replace(/#.*$/gm, ""); // display names and comments may say "no npm"
	assert.doesNotMatch(code, /actions\/checkout|\bnpm\b|\bnpx\b|devenv|nix /, "no checkout, no npm, no nix in the job with the write token");
	assert.match("      - run: npm ci", /\bnpm\b/, "negative control: the pattern does see npm");
	// the release-please job keeps its own write permissions; nothing else gets id-token
	assert.doesNotMatch(build + job(text, "release-please"), /id-token/);
	// negative control: a build job with a write permission must be judged wrong
	assert.match(build.replace("contents: read", "contents: write"), /:\s*write\b/);
});

test("ci.yml installs without running dependency install scripts", () => {
	const text = readFileSync(join(dir, "ci.yml"), "utf8");
	const installs = [...text.matchAll(/^\s*npm ci\b.*$/gm)].map((m) => m[0].trim());
	assert.ok(installs.length >= 1, "no npm ci line seen, the scan may be blind");
	for (const line of installs) assert.match(line, /--ignore-scripts/, line);
});

test("osv-scanner.toml: every ignored advisory has a reason and a future expiry within ~100 days", () => {
	const toml = readFileSync(join(root, "osv-scanner.toml"), "utf8");
	const blocks = toml.split("[[IgnoredVulns]]").slice(1);
	assert.ok(blocks.length >= 1, "no [[IgnoredVulns]] entries seen, the scan may be blind");
	for (const b of blocks) {
		assert.match(b, /^\s*id = "GHSA-[a-z0-9-]+"/m);
		assert.match(b, /^\s*reason = ".{30,}"/m, "reason too short");
		const m = /^\s*ignoreUntil = (\d{4}-\d{2}-\d{2})/m.exec(b);
		assert.ok(m, "ignoreUntil missing");
		const days = (Date.parse(`${m[1]}T00:00:00Z`) - Date.now()) / 86_400_000;
		assert.ok(days < 100, `ignoreUntil ${m[1]} is more than ~100 days ahead`);
		assert.ok(days > -1, `ignoreUntil ${m[1]} has passed: re-review the advisory`);
	}
});

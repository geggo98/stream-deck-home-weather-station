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
	// top-level block, or one on every job (checked loosely: at least one `permissions:` key)
	return /^permissions:/m.test(text) || /^\s{4}permissions:/m.test(text);
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

test("release.yml publish job checks out the release tag from release-please, with SHA-pinned checkout", () => {
	const text = readFileSync(join(dir, "release.yml"), "utf8");
	const publish = text.slice(text.indexOf("\n  publish:"));
	assert.ok(publish.length > 20, "publish job not found");
	assert.match(publish, /actions\/checkout@[0-9a-f]{40}/);
	assert.match(publish, /ref:\s*\$\{\{\s*needs\.release-please\.outputs\.tag_name\s*\}\}/, "checkout must use the tag, not default HEAD");
	assert.match(text, /tag_name:\s*\$\{\{\s*steps\.rp\.outputs\.tag_name\s*\}\}/);
	// negative control: the same job without a ref must be judged wrong
	const without = publish.replace(/\s*ref:.*\n/, "\n");
	assert.doesNotMatch(without, /ref:\s*\$\{\{\s*needs\.release-please/);
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

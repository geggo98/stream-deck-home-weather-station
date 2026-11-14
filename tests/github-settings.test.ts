/**
 * scripts/github-settings.py is the settings-as-code for the repository's supply-chain
 * hardening. These tests run its network-free --print-plan mode and check that the
 * Actions allow-list is exactly the set of pinned actions the workflows use (so the
 * "approval" cannot silently drift from the workflows), and that an unpinned workflow is
 * refused instead of producing a looser allow-list.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts", "github-settings.py");

function run(cwdRoot: string): { status: number | null; stdout: string; stderr: string } {
	const r = spawnSync("python3", ["-I", join(cwdRoot, "scripts", "github-settings.py"), "--print-plan"], { encoding: "utf8" });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function usesIn(dir: string): string[] {
	const refs = new Set<string>();
	for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
		for (const m of readFileSync(join(dir, f), "utf8").matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm)) refs.add(m[1]!);
	}
	return [...refs].sort();
}

describe("github settings plan", () => {
	const result = run(root);
	const plan = JSON.parse(result.stdout) as Record<string, any>;

	it("prints a plan without network access", () => {
		assert.equal(result.status, 0, result.stderr);
		assert.ok(plan.rulesets.length >= 2);
	});

	it("allows exactly the pinned actions the workflows use, nothing GitHub-owned or verified by default", () => {
		const fromWorkflows = usesIn(join(root, ".github", "workflows"));
		assert.ok(fromWorkflows.length >= 4, `looked at ${fromWorkflows.length} action references, expected more`);
		const wrappers = Object.keys(plan.transitive_pins as Record<string, string>);
		const nested = Object.values(plan.transitive_pins as Record<string, string>);
		for (const ref of [...wrappers, ...nested]) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, "a transitive pin and its wrapper are full commit SHAs");
		assert.deepEqual(plan.selected_actions.patterns_allowed, [...new Set([...fromWorkflows, ...nested])].sort(), "workflow pins plus the documented transitive pins, nothing else");
		for (const ref of plan.selected_actions.patterns_allowed as string[]) assert.match(ref, /@[0-9a-f]{40}$/);
		assert.equal(plan.selected_actions.github_owned_allowed, false);
		assert.equal(plan.selected_actions.verified_allowed, false);
	});

	it("the nested pin is recorded for the exact attest-build-provenance pin of release.yml (re-resolve it when Dependabot bumps the wrapper)", () => {
		const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
		const wrapper = /uses:\s*(actions\/attest-build-provenance@[0-9a-f]{40})/.exec(release)?.[1];
		assert.ok(wrapper, "release.yml uses actions/attest-build-provenance");
		// literal on purpose: the expectation must not come from the plan itself
		const expectedNested = "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d";
		assert.equal(
			plan.transitive_pins[wrapper!],
			expectedNested,
			`the wrapper pin ${wrapper} in release.yml has no matching TRANSITIVE_PINS entry: re-resolve the nested pin ` +
				`(gh api "repos/actions/attest-build-provenance/contents/action.yml?ref=<sha>" --jq .content | base64 -d | grep uses:), ` +
				"then replace the key and value in scripts/github-settings.py and the literal in this test",
		);
		assert.ok((plan.selected_actions.patterns_allowed as string[]).includes(expectedNested), "the nested pin is on the allow-list");
	});

	it("a wrapper pin that differs from the key drops the nested pin from the plan (negative control)", () => {
		const dir = mkdtempSync(join(tmpdir(), "ghs-"));
		try {
			mkdirSync(join(dir, "scripts"));
			mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
			cpSync(script, join(dir, "scripts", "github-settings.py"));
			writeFileSync(join(dir, ".github", "workflows", "x.yml"), `jobs:\n  a:\n    steps:\n      - uses: actions/attest-build-provenance@${"0".repeat(40)}\n`);
			const r = run(dir);
			assert.equal(r.status, 0, r.stderr);
			const p = JSON.parse(r.stdout);
			assert.deepEqual(p.transitive_pins, {});
			assert.ok(!(p.selected_actions.patterns_allowed as string[]).some((x) => x.startsWith("actions/attest@")));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("requires SHA pinning, a read-only token and approval for every outside contributor", () => {
		assert.equal(plan.actions_permissions.sha_pinning_required, true);
		assert.equal(plan.actions_permissions.allowed_actions, "selected");
		assert.equal(plan.workflow_permissions.default_workflow_permissions, "read");
		assert.equal(plan.fork_pr_approval.approval_policy, "first_time_contributors");
	});

	it("protects the default branch and the release tags, with no bypass actors", () => {
		const byName = Object.fromEntries((plan.rulesets as any[]).map((r) => [r.name, r]));
		for (const name of ["protect-default-branch", "protect-release-tags"]) {
			assert.equal(byName[name]?.enforcement, "active", name);
			assert.deepEqual(byName[name].bypass_actors, [], name);
		}
		const branchRules = byName["protect-default-branch"].rules.map((r: any) => r.type).sort();
		assert.deepEqual(branchRules, ["deletion", "non_fast_forward"]);
		const tagRules = byName["protect-release-tags"].rules.map((r: any) => r.type).sort();
		assert.deepEqual(tagRules, ["deletion", "non_fast_forward", "update"]);
	});

	it("enables secret scanning with push protection", () => {
		const s = plan.repository.security_and_analysis;
		assert.equal(s.secret_scanning.status, "enabled");
		assert.equal(s.secret_scanning_push_protection.status, "enabled");
	});

	it("refuses a workflow that references a tag instead of a commit (negative control)", () => {
		const dir = mkdtempSync(join(tmpdir(), "ghs-"));
		try {
			mkdirSync(join(dir, "scripts"));
			mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
			cpSync(script, join(dir, "scripts", "github-settings.py"));
			writeFileSync(join(dir, ".github", "workflows", "x.yml"), "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n");
			const r = run(dir);
			assert.notEqual(r.status, 0);
			assert.match(r.stderr, /not pinned to a full commit SHA/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

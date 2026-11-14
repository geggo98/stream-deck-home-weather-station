/**
 * The 7-day cooldown is a supply-chain control: a freshly published release is the most likely to be
 * hijacked or broken. It is configured twice, and both places are pinned here so that a "cleanup" cannot
 * silently drop it: Dependabot waits before proposing a version, npm refuses a too-new version on install.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const MIN_DAYS = 7;

/** The `default-days` of every `cooldown:` block, in file order, with the ecosystem it belongs to. */
function dependabotCooldowns(yaml: string): Array<{ ecosystem: string; days: number | undefined }> {
	const blocks = yaml.split(/^\s*-\s+package-ecosystem:\s*/m).slice(1);
	return blocks.map((block) => {
		const ecosystem = block.split("\n", 1)[0]!.trim();
		const days = /cooldown:\s*\n\s*default-days:\s*(\d+)/.exec(block)?.[1];
		return { ecosystem, days: days === undefined ? undefined : Number(days) };
	});
}

describe("dependency cooldown", () => {
	const yaml = readFileSync(join(root, ".github", "dependabot.yml"), "utf8");
	const cooldowns = dependabotCooldowns(yaml);

	it("Dependabot waits at least 7 days for every ecosystem it watches (npm and GitHub Actions)", () => {
		assert.deepEqual(cooldowns.map((c) => c.ecosystem).sort(), ["github-actions", "npm"], "the parser must see both ecosystems, or a blind pass would hide a missing block");
		for (const c of cooldowns) assert.ok(c.days !== undefined && c.days >= MIN_DAYS, `${c.ecosystem}: cooldown default-days is ${c.days}, need >= ${MIN_DAYS}`);
	});

	it("npm refuses versions younger than 7 days through the project .npmrc", () => {
		const npmrc = readFileSync(join(root, ".npmrc"), "utf8");
		const days = Number(/^\s*min-release-age\s*=\s*(\d+)\s*$/m.exec(npmrc)?.[1]);
		assert.ok(days >= MIN_DAYS, `.npmrc min-release-age is ${days}, need >= ${MIN_DAYS}`);
	});

	it("the parser itself can fail: a block without a cooldown is reported as undefined (negative control)", () => {
		const broken = "updates:\n  - package-ecosystem: npm\n    directory: /\n  - package-ecosystem: github-actions\n    cooldown:\n      default-days: 3\n";
		assert.deepEqual(dependabotCooldowns(broken), [{ ecosystem: "npm", days: undefined }, { ecosystem: "github-actions", days: 3 }]);
	});
});

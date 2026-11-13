/**
 * `streamdeck pack` rewrites manifest.json (no trailing newline); the pack wrapper restores it.
 * Works on a COPY of the plugin folder, so parallel test files never see a rewritten manifest.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PLUGIN_DIR, PLUGIN_DIR_NAME, PROJECT_ROOT } from "../scripts/lib/plugin-id.ts";

const cli = resolve(PROJECT_ROOT, "node_modules/.bin/streamdeck");
const wrapper = resolve(PROJECT_ROOT, "scripts/lib/pack.ts");

describe("pack wrapper", () => {
	it("leaves the manifest byte for byte as it was, and the CLI really does rewrite it (negative control)", (t) => {
		if (!existsSync(cli) || !existsSync(join(PLUGIN_DIR, "bin/plugin.js"))) {
			t.skip("needs the streamdeck CLI and a built bundle");
			return;
		}
		const work = mkdtempSync(join(tmpdir(), "pack-test-"));
		try {
			const copy = join(work, PLUGIN_DIR_NAME);
			cpSync(PLUGIN_DIR, copy, { recursive: true });
			const manifest = join(copy, "manifest.json");
			const original = readFileSync(manifest);
			assert.equal(original.at(-1), 0x0a, "the committed manifest ends with a newline");

			// Control: the bare CLI changes the file. If it ever stops doing so the wrapper is unnecessary.
			const bare = join(work, "bare");
			const bareRun = spawnSync(cli, ["pack", copy, "--output", bare, "--force", "--no-update-check"], { encoding: "utf-8" });
			assert.equal(bareRun.status, 0, bareRun.stdout + bareRun.stderr);
			const rewritten = readFileSync(manifest);
			assert.ok(!rewritten.equals(original), "the CLI rewrote the manifest");
			assert.deepEqual(JSON.parse(rewritten.toString()), JSON.parse(original.toString()), "same data, different bytes");
			writeFileSync(manifest, original);

			const out = join(work, "out");
			const run = spawnSync(process.execPath, [wrapper, "--plugin-dir", copy, "--output", out], { encoding: "utf-8" });
			assert.equal(run.status, 0, run.stdout + run.stderr);
			assert.ok(readFileSync(manifest).equals(original), "restored exactly");
			assert.ok(readdirSync(out).some((f) => f.endsWith(".streamDeckPlugin")), "and the package was made");
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	it("restores the manifest and reports failure when the pack fails", (t) => {
		if (!existsSync(cli)) {
			t.skip("needs the streamdeck CLI");
			return;
		}
		const work = mkdtempSync(join(tmpdir(), "pack-test-"));
		try {
			const copy = join(work, PLUGIN_DIR_NAME);
			cpSync(PLUGIN_DIR, copy, { recursive: true });
			const manifest = join(copy, "manifest.json");
			const original = readFileSync(manifest);
			// A file where the output directory should be: the CLI fails after it has read the manifest.
			const blocker = join(work, "out");
			writeFileSync(blocker, "not a directory");
			const run = spawnSync(process.execPath, [wrapper, "--plugin-dir", copy, "--output", blocker], { encoding: "utf-8" });
			assert.notEqual(run.status, 0);
			assert.ok(readFileSync(manifest).equals(original));
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});

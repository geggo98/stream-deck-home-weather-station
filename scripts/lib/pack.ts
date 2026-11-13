#!/usr/bin/env tsx
/**
 * `streamdeck pack`, then put manifest.json back byte for byte.
 *
 * Measured with the installed CLI: `pack` REWRITES manifest.json in place (the same data,
 * but without the trailing newline the generator writes), so a plain `npm run pack` leaves
 * the committed manifest modified and the drift test in tests/catalog-manifest.test.ts
 * (which compares the exact text) red. This wrapper remembers the text before the pack and
 * restores it afterwards, also when the pack failed, so `git status` stays clean.
 *
 * Usage: tsx scripts/lib/pack.ts [--plugin-dir <dir>] [--output <dir>]
 *   --plugin-dir  the .sdPlugin folder (default: the project's; tests pass a copy)
 *   --output      where the .streamDeckPlugin goes (default: the project root, git-ignored)
 * `npm run verify:manifest` runs before this in the `pack` script.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLUGIN_DIR, PROJECT_ROOT } from "./plugin-id.ts";

function option(name: string, fallback: string): string {
	const at = process.argv.indexOf(name);
	const value = at === -1 ? undefined : process.argv[at + 1];
	return value && !value.startsWith("--") ? resolve(value) : fallback;
}

const pluginDir = option("--plugin-dir", PLUGIN_DIR);
const output = option("--output", PROJECT_ROOT);
const manifestPath = resolve(pluginDir, "manifest.json");
const cli = resolve(PROJECT_ROOT, "node_modules/.bin/streamdeck");

if (!existsSync(cli)) {
	console.error(`ERROR: ${cli} not found; run npm ci.`);
	process.exit(1);
}

const before = readFileSync(manifestPath);
let status = 1;
try {
	const run = spawnSync(cli, ["pack", pluginDir, "--output", output, "--force", "--no-update-check"], { stdio: "inherit" });
	status = run.status ?? 1;
} finally {
	const after = readFileSync(manifestPath);
	if (!after.equals(before)) {
		writeFileSync(manifestPath, before);
		console.log("manifest.json restored to its committed form (the CLI rewrites it without the trailing newline).");
	}
}
process.exit(status);

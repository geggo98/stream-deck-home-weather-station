#!/usr/bin/env tsx
/**
 * Derive the manifest's 4-part Version from package.json's SemVer, and set the Node debug
 * mode for the build we are about to produce.
 *
 * package.json (3-part SemVer, bumped by release-please) is the single source of truth.
 * The Stream Deck CLI requires {major}.{minor}.{patch}.{build}, so the manifest mirrors it
 * as "{major}.{minor}.{patch}.0" on every build; a pre-release suffix is dropped because
 * the manifest format has no place for it.
 *
 * `Nodejs.Debug: "enabled"` launches the plugin with an open Node inspector port (a local
 * code-execution path into the plugin process) and flips the SDK to TRACE logging (every
 * WebSocket frame, i.e. complete settings objects, into the log). It must never ship.
 * `--debug` (or SD_DEBUG=1) turns it on for the local loop (`npm run watch`); a plain
 * `npm run build` removes it again, and `npm run verify:manifest` fails a pack that still
 * has it.
 *
 * The off state is the key being ABSENT, never "disabled": Stream Deck refuses to launch
 * a plugin with `Nodejs.Debug: "disabled"` (the process exits with code 1 before any JS
 * runs, so nothing is logged and the plugin just looks dead). Observed in a sibling
 * project; not re-measured here.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MANIFEST_PATH, PROJECT_ROOT } from "./lib/plugin-id.ts";

const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8"));
const [major, minor, patch] = String(pkg.version).split(/[.+-]/);
const manifestVersion = `${major}.${minor}.${patch}.0`;
if (!/^\d+\.\d+\.\d+\.0$/.test(manifestVersion)) {
	console.error(`package.json version "${pkg.version}" does not look like SemVer`);
	process.exit(1);
}

// A CLI flag rather than only an env var: it works the same on Windows cmd.
const debugRequested = process.argv.includes("--debug") || process.env.SD_DEBUG === "1";

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const changes: string[] = [];

if (manifest.Version !== manifestVersion) {
	manifest.Version = manifestVersion;
	changes.push(`Version -> ${manifestVersion} (from package.json ${pkg.version})`);
}

manifest.Nodejs ??= {};
if (debugRequested) {
	if (manifest.Nodejs.Debug !== "enabled") {
		manifest.Nodejs.Debug = "enabled";
		changes.push('Nodejs.Debug -> "enabled"');
	}
} else if ("Debug" in manifest.Nodejs) {
	delete manifest.Nodejs.Debug;
	changes.push("Nodejs.Debug removed");
}

if (changes.length === 0) {
	console.log(`manifest already in sync (Version ${manifestVersion}, Nodejs.Debug ${debugRequested ? '"enabled"' : "absent"}).`);
} else {
	writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
	console.log(`Synced manifest: ${changes.join(", ")}.`);
}

if (debugRequested) {
	console.warn(
		"WARNING: Nodejs.Debug is enabled. This opens a Node inspector port and logs at TRACE. " +
			"Do not commit or pack this manifest; `npm run build` resets it.",
	);
}

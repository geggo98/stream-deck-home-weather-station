#!/usr/bin/env tsx
/**
 * Refuse to ship a manifest that has the Node inspector switched on (or set to "disabled").
 *
 * `Nodejs.Debug: "enabled"` opens an inspector port (code execution for any local process
 * that reaches it) and flips the SDK to TRACE logging, which writes every WebSocket frame,
 * complete settings objects included, into plaintext log files. Useful in the dev loop,
 * never for a user. `"disabled"` is worse than useless: Stream Deck then refuses to launch
 * the plugin at all. The release state is the key being absent.
 *
 * `npm run build` already removes the key (sync-manifest-version.ts). This is the backstop
 * for a manifest committed from the watch loop and for `npm run pack` without a build.
 * Wired into `pack` and CI.
 */

import { readFileSync } from "node:fs";
import { MANIFEST_PATH } from "./lib/plugin-id.ts";

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

if (manifest.Nodejs && "Debug" in manifest.Nodejs) {
	console.error(
		`ERROR: manifest has Nodejs.Debug: ${JSON.stringify(manifest.Nodejs.Debug)}; it must be absent.\n` +
			'"enabled" opens an inspector port and logs at TRACE; "disabled" makes Stream Deck refuse to\n' +
			"launch the plugin. Run `npm run build` to remove the key, then retry.",
	);
	process.exit(1);
}
if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(manifest.Version))) {
	console.error(`ERROR: manifest Version "${manifest.Version}" is not 4-part (major.minor.patch.build).`);
	process.exit(1);
}

console.log("manifest has no Nodejs.Debug key and a 4-part Version - safe to release.");

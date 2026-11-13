/**
 * Tests for the BUILT bundle, which nothing else in this suite looks at.
 *
 * Every other test imports TypeScript sources directly (Node strips the types), so the
 * bundler is never exercised. A bundler that emitted legacy decorators, or silently lowered
 * class fields, would leave every other test green and break the plugin at runtime.
 *
 * The checks are toolchain-neutral:
 *  1. the bundle parses under this Node (`node --check`);
 *  2. it carries the STANDARD decorator context (`addInitializer`, `kind:"class"`);
 *  3. it evaluates far enough to register every action in the manifest;
 *  4. the harness proves its own signal: the same probe against a deliberately broken setup
 *     must fail. The exit code is useless as a signal, because the plugin's own
 *     uncaughtException net swallows a failed registration and still exits 0, so the probe
 *     reads a LOG MARKER instead.
 *
 * The weather service is created at connect time. Until the real adapter replaces the stub
 * in src/adapter/station/create-service.ts the bundle must tolerate the stub's throw; once
 * the real one is there, the corresponding test below starts running by itself.
 *
 * CI builds before it tests; locally the bundle may be missing, and the suite then says so
 * instead of passing quietly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PLUGIN_DIR_NAME } from "../scripts/lib/plugin-id.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN_DIR = join(ROOT, PLUGIN_DIR_NAME);
const BUNDLE = join(PLUGIN_DIR, "bin/plugin.js");
const MANIFEST = join(PLUGIN_DIR, "manifest.json");
const SERVICE_SOURCE = join(ROOT, "src/adapter/station/create-service.ts");

const built = existsSync(BUNDLE);
/** The stub says so in its own text; the real implementation will not. */
const STUB_TEXT = "createWeatherService is not implemented yet";
const serviceIsStub = existsSync(SERVICE_SOURCE) && readFileSync(SERVICE_SOURCE, "utf-8").includes(STUB_TEXT);

const REGISTERED = /Home Weather Station: registered (\d+) actions/;

/**
 * Run the bundle in a throwaway directory. The SDK resolves `manifest.json` from the working
 * directory and writes its log next to it, so this isolates the run from the real plugin's
 * logs and lets the manifest be withheld on purpose. HOME and the data-dir variables point
 * into the same directory, so a real adapter can never touch a real user's credential file.
 */
function runBundle(options: { withManifest: boolean }): { status: number | null; log: string } {
	const dir = mkdtempSync(join(tmpdir(), "home-weather-bundle-"));
	try {
		if (options.withManifest) copyFileSync(MANIFEST, join(dir, "manifest.json"));
		const result = spawnSync(process.execPath, [BUNDLE], {
			cwd: dir,
			encoding: "utf-8",
			timeout: 30_000,
			env: { PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: dir, APPDATA: dir, LOCALAPPDATA: dir },
		});
		const logDir = join(dir, "logs");
		const log = existsSync(logDir)
			? readdirSync(logDir)
					.map((file) => readFileSync(join(logDir, file), "utf-8"))
					.join("\n")
			: "";
		return { status: result.status, log };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("built bundle", { skip: built ? false : "run `npm run build` first" }, () => {
	it("parses under this Node", () => {
		// A transpiler without a standard-decorator transform leaves `@action(...) class` in
		// the output and still exits 0.
		const check = spawnSync(process.execPath, ["--check", BUNDLE], { encoding: "utf-8" });
		assert.equal(check.status, 0, `node --check failed:\n${check.stderr}`);
	});

	it("applies decorators with a standard context object", () => {
		// Standard decorators are called with (value, context); legacy emit passes the target
		// alone, so neither literal below can appear. Both survive minification.
		const bundle = readFileSync(BUNDLE, "utf-8");
		assert.ok(bundle.includes("addInitializer"), "no decorator context - legacy decorator emit?");
		assert.ok(bundle.includes('kind:"class"') || bundle.includes('kind: "class"'), "no class-decorator context kind - legacy decorator emit?");
	});

	it("registers every action in the manifest when it runs", () => {
		// `registerAction` throws for a UUID that is not in the manifest, and the marker line
		// comes AFTER every registration in plugin.ts, so reaching it proves all succeeded.
		const { log } = runBundle({ withManifest: true });
		const marker = REGISTERED.exec(log);
		assert.ok(marker, `registration did not complete:\n${log}`);
		const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8")) as { Actions: unknown[] };
		// Derived, not typed in: the count would go stale the first time an action is added.
		assert.equal(Number(marker[1]), manifest.Actions.length);
		assert.ok(manifest.Actions.length >= 8, `expected the full action set, found ${manifest.Actions.length}`);
		assert.doesNotMatch(log, /uncaught exception/i, `the bundle threw while loading:\n${log}`);
		// Not connecting is expected: there is no Stream Deck to talk to here.
		assert.match(log, /missing command line arguments/, "expected the connection to fail without Stream Deck");
	});

	it("would notice if registration broke", () => {
		// The self-check. Same probe, manifest withheld, so `registerAction` throws: the
		// assertions above must be able to see that. The exit code stays 0 either way, which
		// is precisely why the test above reads the log rather than the status.
		const { status, log } = runBundle({ withManifest: false });
		assert.match(log, /uncaught exception/i, "expected the missing manifest to surface as an exception");
		assert.doesNotMatch(log, REGISTERED, "registration must not complete without a manifest");
		assert.equal(status, 0, "and the exit code is 0 regardless - so it is not a usable signal");
	});

	it("tolerates the stub weather service: the key actions are still registered", { skip: serviceIsStub ? false : "the real service is in place" }, () => {
		const { log } = runBundle({ withManifest: true });
		assert.match(log, /Weather service could not be created/, "the stub's throw should be logged, not fatal");
		assert.match(log, REGISTERED);
		assert.doesNotMatch(log, /uncaught exception/i);
	});

	it(
		"creates the real weather service without error",
		{ skip: serviceIsStub ? "createWeatherService is still the stub; this runs once the adapter lands" : false },
		() => {
			const { log } = runBundle({ withManifest: true });
			assert.doesNotMatch(log, /Weather service could not be created/, log);
			assert.match(log, REGISTERED);
			assert.equal(readFileSync(BUNDLE, "utf-8").includes(STUB_TEXT), false, "the bundle still carries the stub");
		},
	);
});

describe("built bundle (not built)", { skip: built ? "the bundle is present" : false }, () => {
	it("is missing, so the artifact checks were skipped", () => {
		// Loud rather than silent: CI builds before testing, so this only fires locally.
		assert.ok(!built);
	});
});

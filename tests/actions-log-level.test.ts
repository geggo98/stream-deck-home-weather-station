/** HOME_WEATHER_LOG_LEVEL is validated against the SDK's levels instead of being cast. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chooseLogLevel, LOG_LEVELS } from "../src/actions/log-level.ts";

describe("chooseLogLevel", () => {
	it("defaults to info, debug mode means debug", () => {
		assert.deepEqual(chooseLogLevel({}), { level: "info" });
		assert.deepEqual(chooseLogLevel({ HOME_WEATHER_DEBUG: "1" }), { level: "debug" });
	});

	it("accepts every SDK level, in any case, trimmed", () => {
		for (const level of LOG_LEVELS) assert.deepEqual(chooseLogLevel({ HOME_WEATHER_LOG_LEVEL: ` ${level.toUpperCase()} ` }), { level });
	});

	it("an explicit level beats debug mode", () => {
		assert.deepEqual(chooseLogLevel({ HOME_WEATHER_LOG_LEVEL: "warn", HOME_WEATHER_DEBUG: "1" }), { level: "warn" });
	});

	it("a value that is not a level is ignored and reported, never passed on", () => {
		assert.deepEqual(chooseLogLevel({ HOME_WEATHER_LOG_LEVEL: "verbose" }), { level: "info", ignored: "verbose" });
		assert.deepEqual(chooseLogLevel({ HOME_WEATHER_LOG_LEVEL: "verbose", HOME_WEATHER_DEBUG: "1" }), { level: "debug", ignored: "verbose" });
		assert.equal(chooseLogLevel({ HOME_WEATHER_LOG_LEVEL: "x".repeat(100) }).ignored?.length, 32, "reported value is bounded");
	});

	it("an empty value is the same as unset", () => {
		assert.deepEqual(chooseLogLevel({ HOME_WEATHER_LOG_LEVEL: "  " }), { level: "info" });
	});
});

describe("plugin.ts wiring (the file imports the SDK, so it is read, not run)", () => {
	const source = readFileSync(fileURLToPath(new URL("../src/plugin.ts", import.meta.url)), "utf-8");

	it("catches the connect promise (CLAUDE.md: no floating promises)", () => {
		assert.doesNotMatch(source, /streamDeck\.connect\(\)\s*;/);
		assert.match(source, /streamDeck\.connect\(\)\.catch\(/);
	});

	it("takes the log level from chooseLogLevel and sends replies without a type-erasing cast", () => {
		assert.match(source, /chooseLogLevel\(process\.env\)/);
		assert.doesNotMatch(source, /HOME_WEATHER_LOG_LEVEL\s*\?\?/);
		assert.doesNotMatch(source, /as unknown as/);
	});

	it("loads the global settings through the retrying loader", () => {
		assert.match(source, /loadGlobalSettingsWithRetry\(/);
		assert.doesNotMatch(source, /markGlobalSettingsLoaded\(\)/);
	});
});

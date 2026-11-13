/**
 * The initial load of the global settings, with retries (src/actions/global-settings.ts).
 * Own file: the load gate is process-wide state that opens once, and these cases need a
 * fresh process for each outcome (a failed load must leave the gate closed).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	areGlobalSettingsLoaded,
	asGlobalSettings,
	getCachedGlobalSettings,
	globalSettingsError,
	loadGlobalSettingsWithRetry,
	SETTINGS_UNAVAILABLE_MESSAGE,
	updateGlobalSettings,
	setGlobalSettingsWriter,
} from "../src/actions/global-settings.ts";

const noSleep = async (): Promise<void> => {};

function logger() {
	const lines: string[] = [];
	return { lines, warn: (m: string) => void lines.push(`warn ${m}`), error: (m: string) => void lines.push(`error ${m}`) };
}

describe("loadGlobalSettingsWithRetry", () => {
	it("a permanently failing load is retried, logged, and leaves the gate closed with the reason on record", async () => {
		let calls = 0;
		const log = logger();
		const loaded = await loadGlobalSettingsWithRetry(
			async () => {
				calls++;
				throw new Error("not connected");
			},
			{ logger: log, sleep: noSleep },
		);
		assert.equal(loaded, false);
		assert.equal(calls, 3, "three attempts");
		assert.equal(areGlobalSettingsLoaded(), false);
		assert.equal(globalSettingsError(), SETTINGS_UNAVAILABLE_MESSAGE);
		assert.equal(log.lines.filter((l) => l.startsWith("warn")).length, 2);
		assert.equal(log.lines.filter((l) => l.startsWith("error")).length, 1);
		// Writes stay refused: nothing may overwrite settings we could not read.
		setGlobalSettingsWriter(async () => {});
		await assert.rejects(updateGlobalSettings((c) => ({ ...c, unitSystem: "metric" }), 5), /never loaded/);
	});

	it("a load that succeeds on the second attempt opens the gate and clears the report", async () => {
		let calls = 0;
		const loaded = await loadGlobalSettingsWithRetry(
			async () => {
				if (++calls === 1) throw new Error("not connected yet");
				return { pollIntervalSeconds: 120, other: "kept" };
			},
			{ logger: logger(), sleep: noSleep },
		);
		assert.equal(loaded, true);
		assert.equal(calls, 2);
		assert.equal(areGlobalSettingsLoaded(), true);
		assert.equal(globalSettingsError(), undefined, "an open gate reports no failure");
		assert.equal(getCachedGlobalSettings().other, "kept");
	});

	it("waits between attempts", async () => {
		const waits: number[] = [];
		await loadGlobalSettingsWithRetry(
			async () => {
				throw new Error("x");
			},
			{ logger: logger(), delayMs: 250, sleep: async (ms) => void waits.push(ms) },
		);
		assert.deepEqual(waits, [250, 250], "after the first and the second failure, not after the last");
	});
});

describe("asGlobalSettings", () => {
	it("keeps objects, replaces everything else by an empty object", () => {
		assert.deepEqual(asGlobalSettings({ unitSystem: "metric" }), { unitSystem: "metric" });
		for (const junk of [null, undefined, "x", 5, [], [1]]) assert.deepEqual(asGlobalSettings(junk), {}, String(junk));
	});
});

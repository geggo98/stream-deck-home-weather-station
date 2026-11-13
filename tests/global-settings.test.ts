/**
 * The global-settings write funnel (src/actions/global-settings.ts).
 *
 * All unrelated subsystems share one object, so every writer merges over the others'
 * values; getting that merge wrong loses data. SDK-free like the module under test: the
 * writer is injected.
 *
 * Order matters: the load gate opens once per process, so the "refuses before the load"
 * case has to run before anything opens it.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	areGlobalSettingsLoaded,
	forgetActionSettings,
	getCachedGlobalSettings,
	globalSettingsError,
	markGlobalSettingsLoadFailed,
	SETTINGS_UNAVAILABLE_MESSAGE,
	getRememberedActionSettings,
	markGlobalSettingsLoaded,
	MAX_TRACKED_ACTION_SETTINGS,
	onGlobalSettingsChanged,
	pollIntervalOf,
	rememberActionSettings,
	setCachedGlobalSettings,
	setGlobalSettingsWriter,
	unitSystemOf,
	updateGlobalSettings,
	waitForGlobalSettings,
} from "../src/actions/global-settings.ts";
import type { GlobalSettings } from "../src/pi-protocol.ts";

describe("updateGlobalSettings", () => {
	it("refuses to write before the initial load has landed", async () => {
		let writes = 0;
		setGlobalSettingsWriter(async () => {
			writes++;
		});
		assert.equal(areGlobalSettingsLoaded(), false);
		// Until the load lands the cache is empty, so a write would persist an object with
		// every other key missing.
		await assert.rejects(updateGlobalSettings((current) => ({ ...current, pollIntervalSeconds: 120 }), 20), /never loaded/);
		assert.equal(writes, 0, "nothing may be persisted while the settings are unknown");
	});

	it("a failed load is reported as such, and the report goes away once the gate is open", () => {
		assert.equal(globalSettingsError(), undefined, "nothing reported before a failure");
		markGlobalSettingsLoadFailed();
		assert.equal(globalSettingsError(), SETTINGS_UNAVAILABLE_MESSAGE);
		assert.equal(areGlobalSettingsLoaded(), false, "the gate stays closed: nothing may be written over unknown settings");
	});

	it("a bounded wait ends even when the load never completes", async () => {
		const started = Date.now();
		await waitForGlobalSettings(15);
		assert.ok(Date.now() - started < 1000);
	});

	it("keeps two independent writers from reverting each other", async () => {
		// Stream Deck does not echo a plugin's own write back, so the cache must be updated
		// by the funnel itself or the next writer merges over a superseded snapshot.
		const persisted: GlobalSettings[] = [];
		setGlobalSettingsWriter(async (gs) => {
			persisted.push(structuredClone(gs));
		});
		setCachedGlobalSettings({ pollIntervalSeconds: 300, other: "kept" });
		markGlobalSettingsLoaded();

		await updateGlobalSettings((current) => ({ ...current, pollIntervalSeconds: 600 }));
		await updateGlobalSettings((current) => ({ ...current, unitSystem: "imperial" }));

		const written = persisted.at(-1);
		assert.equal(written?.unitSystem, "imperial");
		assert.equal(written?.pollIntervalSeconds, 600, "the second write must not revert the first");
		assert.equal(written?.other, "kept", "unknown keys survive");
		assert.equal(getCachedGlobalSettings().pollIntervalSeconds, 600);
	});

	it("skips the round trip when the patch returns undefined", async () => {
		let writes = 0;
		setGlobalSettingsWriter(async () => {
			writes++;
		});
		await updateGlobalSettings(() => undefined);
		assert.equal(writes, 0);
	});

	it("serialises writes, so a queued patch sees the one before it", async () => {
		const order: number[] = [];
		setCachedGlobalSettings({ counter: 0 });
		setGlobalSettingsWriter(async (gs) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push(gs.counter as number);
		});
		const bump = (current: GlobalSettings) => ({ ...current, counter: (current.counter as number) + 1 });
		await Promise.all([updateGlobalSettings(bump), updateGlobalSettings(bump), updateGlobalSettings(bump)]);
		assert.deepEqual(order, [1, 2, 3]);
	});

	it("takes the new values back out of the cache after a failed write, tells listeners, and keeps the chain alive", async () => {
		setCachedGlobalSettings({ pollIntervalSeconds: 300 });
		const seen: Array<number | undefined> = [];
		const off = onGlobalSettingsChanged(() => seen.push(pollIntervalOf(getCachedGlobalSettings())));
		setGlobalSettingsWriter(async () => {
			throw new Error("disk full");
		});
		await assert.rejects(updateGlobalSettings((c) => ({ ...c, pollIntervalSeconds: 900 })), /disk full/);
		off();
		assert.equal(getCachedGlobalSettings().pollIntervalSeconds, 300, "a value that was never saved must not stay in effect");
		assert.deepEqual(seen, [900, 300], "listeners saw the value and then its withdrawal");
		assert.equal(globalSettingsError(), undefined, "an open gate reports no load failure");
		const persisted: GlobalSettings[] = [];
		setGlobalSettingsWriter(async (gs) => {
			persisted.push(gs);
		});
		await updateGlobalSettings((c) => ({ ...c, unitSystem: "metric" }));
		assert.equal(persisted[0]?.pollIntervalSeconds, 300, "the failed value does not ride along");
		assert.equal(persisted[0]?.unitSystem, "metric", "the chain still works");
	});

	it("does not undo a cache that something else replaced while the write was failing", async () => {
		setCachedGlobalSettings({ pollIntervalSeconds: 300 });
		setGlobalSettingsWriter(async () => {
			setCachedGlobalSettings({ pollIntervalSeconds: 600 }); // an external edit arrives meanwhile
			throw new Error("disk full");
		});
		await assert.rejects(updateGlobalSettings((c) => ({ ...c, pollIntervalSeconds: 900 })), /disk full/);
		assert.equal(getCachedGlobalSettings().pollIntervalSeconds, 600);
	});

	it("fails clearly when no writer was injected", async () => {
		setGlobalSettingsWriter(undefined);
		await assert.rejects(updateGlobalSettings((c) => ({ ...c })), /no global-settings writer/);
	});
});

describe("cache listeners and validated accessors", () => {
	it("notifies listeners on every cache replacement; a throwing listener breaks nothing", () => {
		let calls = 0;
		const off = onGlobalSettingsChanged(() => {
			calls++;
		});
		const off2 = onGlobalSettingsChanged(() => {
			throw new Error("listener bug");
		});
		setCachedGlobalSettings({});
		setCachedGlobalSettings(undefined);
		assert.equal(calls, 2);
		off();
		off2();
		setCachedGlobalSettings({});
		assert.equal(calls, 2);
	});

	it("clamps the poll interval and ignores junk", () => {
		assert.equal(pollIntervalOf({ pollIntervalSeconds: 30 }), 60);
		assert.equal(pollIntervalOf({ pollIntervalSeconds: 100000 }), 3600);
		assert.equal(pollIntervalOf({ pollIntervalSeconds: 300.4 }), 300);
		assert.equal(pollIntervalOf({ pollIntervalSeconds: "300" as never }), undefined);
		assert.equal(pollIntervalOf({ pollIntervalSeconds: Number.NaN }), undefined);
		assert.equal(pollIntervalOf({}), undefined);
	});

	it("falls back to following the account for any unit system but the two explicit ones", () => {
		assert.equal(unitSystemOf({ unitSystem: "metric" }), "metric");
		assert.equal(unitSystemOf({ unitSystem: "imperial" }), "imperial");
		assert.equal(unitSystemOf({ unitSystem: "x" as never }), "account");
		assert.equal(unitSystemOf({}), "account");
	});
});

describe("per-action settings memory", () => {
	it("remembers and forgets", () => {
		rememberActionSettings("a1", { moduleKey: "s|m" });
		assert.equal(getRememberedActionSettings("a1")?.moduleKey, "s|m");
		forgetActionSettings("a1");
		assert.equal(getRememberedActionSettings("a1"), undefined);
	});

	it("is bounded: the oldest entry makes room", () => {
		for (let i = 0; i < MAX_TRACKED_ACTION_SETTINGS + 5; i++) rememberActionSettings(`bound-${i}`, {});
		assert.equal(getRememberedActionSettings("bound-0"), undefined);
		assert.ok(getRememberedActionSettings(`bound-${MAX_TRACKED_ACTION_SETTINGS + 4}`));
		for (let i = 0; i < MAX_TRACKED_ACTION_SETTINGS + 5; i++) forgetActionSettings(`bound-${i}`);
	});
});

describe("single writer", () => {
	it("only src/plugin.ts calls the SDK's setGlobalSettings", () => {
		const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
		const callers: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith(".ts")) {
					const code = readFileSync(path, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
					if (/\bsettings\.setGlobalSettings\s*\(/.test(code)) callers.push(path.slice(srcDir.length).split(sep).join("/"));
				}
			}
		};
		walk(srcDir);
		// Sanity: the scan must be able to see the call it is looking for.
		assert.ok(/\bsettings\.setGlobalSettings\s*\(/.test(readFileSync(join(srcDir, "plugin.ts"), "utf-8")), "scan target moved");
		assert.deepEqual(callers, ["plugin.ts"]);
	});
});

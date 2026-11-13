/** The focus store, and its persistence through the real settings funnel. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { FocusStore } from "../src/focus/focus-store.ts";
import type { Focus } from "../src/focus/navigate.ts";
import { markGlobalSettingsLoaded, setCachedGlobalSettings, setGlobalSettingsWriter, getCachedGlobalSettings, updateGlobalSettings } from "../src/actions/global-settings.ts";
import type { GlobalSettings } from "../src/pi-protocol.ts";
import { BASE_ID, makeFocusStore, settle, STATION_ID } from "./actions-fixtures.ts";

const here: Focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" };
const there: Focus = { ...here, metric: "humidity" };

describe("FocusStore", () => {
	it("reads the stored focus of the previous session and ignores junk", () => {
		assert.deepEqual(makeFocusStore(here).store.get(), here);
		const junk = makeFocusStore();
		junk.global.focus = { stationId: 7 };
		assert.equal(junk.store.get(), undefined);
	});

	it("notifies on a change only, persists it, and does not write the same value twice", async () => {
		const { store, writes } = makeFocusStore(here);
		let calls = 0;
		store.subscribe(() => calls++);
		assert.equal(store.set(here), false, "same value: nothing");
		assert.equal(store.set(there), true);
		assert.equal(calls, 1);
		await settle();
		assert.equal(writes.length, 1);
		assert.deepEqual(writes[0]?.focus, there);
		assert.equal(store.set(there), false);
	});

	it("keeps working in memory when the write fails (and says so once per failure)", async () => {
		const { store, failWrites } = makeFocusStore(here);
		failWrites.value = true;
		store.set(there);
		await settle();
		assert.deepEqual(store.get(), there);
	});

	it("unsubscribes", () => {
		const { store } = makeFocusStore(here);
		let calls = 0;
		const off = store.subscribe(() => calls++);
		off();
		store.set(there);
		assert.equal(calls, 0);
	});
});

describe("the focus goes through the single-writer funnel", () => {
	it("waits for the initial load, then merges over the other global settings in order", async () => {
		const written: GlobalSettings[] = [];
		setGlobalSettingsWriter(async (gs) => {
			written.push(structuredClone(gs));
		});
		const store = new FocusStore({ getGlobal: getCachedGlobalSettings, update: updateGlobalSettings, logger: { warn: () => {} } });
		store.set(here);
		await settle(5);
		assert.equal(written.length, 0, "the gate is closed before the initial load");
		setCachedGlobalSettings({ pollIntervalSeconds: 120 });
		markGlobalSettingsLoaded();
		store.set(there);
		await settle(5);
		assert.equal(written.length, 2, "the early change was queued behind the load, not lost");
		assert.deepEqual(written[0], { pollIntervalSeconds: 120, focus: here });
		assert.deepEqual(written[1], { pollIntervalSeconds: 120, focus: there }, "other settings survive");
		// a fresh store (next session) finds it in the cache
		assert.deepEqual(new FocusStore({ getGlobal: getCachedGlobalSettings, update: updateGlobalSettings, logger: { warn: () => {} } }).get(), there);
	});
});

describe("FocusStore without persisting", () => {
	it("persist: false notifies but writes nothing; flush writes the last value once", async () => {
		const { store, writes } = makeFocusStore(here);
		let calls = 0;
		store.subscribe(() => calls++);
		store.set(there, { persist: false });
		store.set({ ...there, metric: "co2" }, { persist: false });
		await settle();
		assert.equal(calls, 2);
		assert.equal(writes.length, 0);
		store.flush();
		store.flush();
		await settle();
		assert.equal(writes.length, 1, "flush is a no-op once there is nothing unsaved");
		assert.equal((writes[0]?.focus as Focus).metric, "co2");
	});
});

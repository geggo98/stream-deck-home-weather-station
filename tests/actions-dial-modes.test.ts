/**
 * The three dial actions on one controller: Sensor Dial, Value Dial, Custom Dial, each in both
 * scopes of the switch (`followFocus` true = the shared focus, false = only this dial).
 * Fictional fixtures only. UNVERIFIED on hardware.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { getRememberedDefaultMetric, isRememberedAllMetricsAction } from "../src/actions/global-settings.ts";
import { DialController, gesturesOf, type DialMode } from "../src/actions/dial-controller.ts";
import { KeyController } from "../src/actions/key-controller.ts";
import type { ActionSettings } from "../src/focus/settings.ts";
import { metricKeyOf, type Focus } from "../src/focus/navigate.ts";
import { makeModuleKey } from "../src/render/select.ts";
import {
	BASE_B_ID,
	BASE_ID,
	FakeSource,
	makeEnv,
	makeFocusStore,
	makeTwoStationSnapshot,
	OUTDOOR_ID,
	RAIN_ID,
	RecordingDialSurface,
	RecordingKeySurface,
	settle,
	STATION_B_ID,
	STATION_ID,
	WIND_ID,
} from "./actions-fixtures.ts";

const here: Focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" };
const title = (d: RecordingDialSurface) => d.last?.title.value;
const value = (d: RecordingDialSurface) => d.last?.value.value;

function setup(focus: Focus = here) {
	const source = new FakeSource(makeTwoStationSnapshot());
	const f = makeFocusStore(focus);
	const env = makeEnv(source, { focus: f.store, debounceMs: 5 });
	return { source, ...f, env, dials: new DialController({ ...env, persistMs: 15 }), keys: new KeyController({ ...env, overlayMs: 30 }) };
}

async function dialOf(dials: DialController, mode: DialMode, settings: ActionSettings = {}, id = "dial-1") {
	const dial = new RecordingDialSurface(id);
	await dials.appear(dial, settings, mode);
	return dial;
}

describe("gesture mapping", () => {
	it("is fixed for the Sensor Dial and the Value Dial, whatever the settings say", () => {
		const junk: ActionSettings = { dialRotate: "none", dialPressRotate: "none", dialPush: "none" };
		assert.deepEqual(gesturesOf("sensor", junk), { rotate: "sensor", pressRotate: "station", push: "reload" });
		assert.deepEqual(gesturesOf("value", junk), { rotate: "value", pressRotate: "sensor", push: "reload" });
	});

	it("the Custom Dial defaults to today's behaviour and ignores unknown words", () => {
		const today = { rotate: "value", pressRotate: "station", push: "sensor" };
		assert.deepEqual(gesturesOf("custom", {}), today);
		assert.deepEqual(gesturesOf("custom", { dialRotate: "banana" as never, dialPush: 3 as never }), today);
		assert.deepEqual(gesturesOf("custom", { dialRotate: "sensor", dialPressRotate: "none", dialPush: "reload" }), { rotate: "sensor", pressRotate: "none", push: "reload" });
	});
});

describe("Sensor Dial, switch on focus", () => {
	it("shows its own metric (default temperature) of the focused sensor and ignores the focus's value", async () => {
		const { dials, store } = setup();
		const dial = await dialOf(dials, "sensor");
		assert.equal(title(dial), "Temperature");
		store.set({ ...here, metric: "humidity" });
		assert.equal(title(dial), "Temperature", "the focus value does not move it");
		store.set({ ...here, moduleId: OUTDOOR_ID, metric: "humidity" });
		assert.equal(value(dial), "8.4°C", "the focus sensor does");
		const own = await dialOf(dials, "sensor", { metric: "humidity" }, "dial-2");
		assert.equal(title(own), "Humidity");
		assert.equal(value(own), "80%");
	});

	it("turning moves the shared focus to the next sensor, keeps the focus value and repaints followers", async () => {
		const { dials, keys, store, writes } = setup();
		const dial = await dialOf(dials, "sensor");
		const key = new RecordingKeySurface("focus-key");
		await keys.appear(key, {}, { metric: "temperature", follow: true });
		store.set({ ...here, metric: "humidity" });
		dials.rotate(dial.id, 1);
		assert.deepEqual(store.get(), { stationId: STATION_ID, moduleId: OUTDOOR_ID, metric: "humidity" }, "outdoor reports humidity: the focus value stays");
		assert.match(key.lastTitle ?? "", /80/, "a follower repainted");
		assert.equal(title(dial), "Temperature");
		assert.equal(value(dial), "8.4°C");
		assert.ok(writes.length >= 1, "the focus was persisted");
		dials.rotate(dial.id, -1);
		assert.equal(store.get()?.moduleId, BASE_ID, "back");
	});

	it("reaches a rain-like module the focus value does not exist on, by its own metric", async () => {
		const { dials, store } = setup();
		const dial = await dialOf(dials, "sensor", { metric: "rain24h" });
		// Base and outdoor have no rain: the first sensor for the dial is the rain gauge.
		dials.rotate(dial.id, 1);
		assert.equal(store.get()?.moduleId, RAIN_ID);
		assert.equal(store.get()?.metric, metricKeyOf("rain24h"), "the focus value is not on the rain module: the dial's metric is used");
		assert.equal(title(dial), "Rain 24 h");
		assert.equal(value(dial), "7.6 mm");
		dials.rotate(dial.id, 1);
		assert.equal(store.get()?.moduleId, RAIN_ID, "the only module with rain: blocked, nothing moves");
	});

	it("turning while pushed moves the focus to the next station; a push reloads and moves nothing", async () => {
		const { dials, source, store } = setup();
		const dial = await dialOf(dials, "sensor");
		dials.down(dial.id);
		dials.rotate(dial.id, 1, true);
		dials.up(dial.id);
		assert.deepEqual([store.get()?.stationId, store.get()?.moduleId], [STATION_B_ID, BASE_B_ID]);
		assert.equal(source.refreshCalls, 0, "a rotation while pushed is not a push");
		const before = store.get();
		dials.press(dial.id);
		assert.equal(source.refreshCalls, 1);
		assert.deepEqual(store.get(), before);
	});
});

describe("Sensor Dial, switch on only this dial", () => {
	it("adopts its own module, never touches the focus and persists its own position after a quiet period", async () => {
		const { dials, store, writes } = setup();
		const dial = await dialOf(dials, "sensor", { followFocus: false, metric: "humidity" });
		assert.equal(dial.settingsWrites[0]?.moduleKey, makeModuleKey(STATION_ID, BASE_ID), "adopted");
		store.set({ ...here, moduleId: WIND_ID, metric: "windStrength" as never });
		const writesBefore = writes.length;
		assert.equal(value(dial), "45%", "the focus does not move it");
		const focusBefore = store.get();
		dials.rotate(dial.id, 1);
		assert.equal(value(dial), "80%", "now the outdoor sensor");
		assert.equal(title(dial), "Humidity", "its metric stays");
		assert.deepEqual(store.get(), focusBefore);
		assert.equal(writes.length, writesBefore, "no focus write");
		const n = dial.settingsWrites.length;
		await settle(40);
		assert.equal(dial.settingsWrites.length, n + 1);
		assert.equal(dial.settingsWrites.at(-1)?.moduleKey, makeModuleKey(STATION_ID, OUTDOOR_ID));
		assert.equal(dial.settingsWrites.at(-1)?.metric, "humidity");
	});

	it("does not write a metric into its settings while the metric is still the default", async () => {
		const { dials } = setup();
		const dial = await dialOf(dials, "sensor", { followFocus: false, moduleKey: makeModuleKey(STATION_ID, BASE_ID) });
		dials.rotate(dial.id, 1);
		await settle(40);
		assert.equal(dial.settingsWrites.at(-1)?.moduleKey, makeModuleKey(STATION_ID, OUTDOOR_ID));
		assert.equal(dial.settingsWrites.at(-1)?.metric, undefined, "the metric is the PI's setting, not a navigation result");
	});

	it("turning while pushed moves its own station only", async () => {
		const { dials, store } = setup();
		const dial = await dialOf(dials, "sensor", { followFocus: false, moduleKey: makeModuleKey(STATION_ID, BASE_ID) });
		const before = store.get();
		dials.rotate(dial.id, 1, true);
		assert.equal(value(dial), "17.9°C");
		assert.deepEqual(store.get(), before);
	});

	it("also reaches the rain module by its own metric", async () => {
		const { dials } = setup();
		const dial = await dialOf(dials, "sensor", { followFocus: false, metric: "rain24h", moduleKey: makeModuleKey(STATION_ID, BASE_ID) });
		dials.rotate(dial.id, 1);
		assert.equal(value(dial), "7.6 mm");
	});
});

describe("Value Dial", () => {
	it("on focus: shows the focused sensor AND value; turning moves the shared focus's value, followers repaint", async () => {
		const { dials, keys, store, writes } = setup();
		const dial = await dialOf(dials, "value");
		const key = new RecordingKeySurface("focus-key");
		await keys.appear(key, {}, { metric: "temperature", follow: true });
		assert.equal(title(dial), "Temperature");
		dials.rotate(dial.id, 1);
		assert.equal(store.get()?.metric, "humidity");
		assert.equal(title(dial), "Humidity");
		assert.match(key.lastTitle ?? "", /45/, "the follower shows humidity too");
		assert.equal(store.get()?.moduleId, BASE_ID);
		assert.ok(writes.length >= 1);
		store.set({ ...here, moduleId: OUTDOOR_ID });
		assert.equal(value(dial), "8.4°C", "follows a focus move made elsewhere");
	});

	it("on focus: turning while pushed moves the focus to the next sensor, keeping the value; a push reloads", async () => {
		const { dials, source, store } = setup();
		const dial = await dialOf(dials, "value");
		dials.rotate(dial.id, 1, true);
		assert.deepEqual(store.get(), { ...here, moduleId: OUTDOOR_ID });
		dials.press(dial.id);
		assert.equal(source.refreshCalls, 1);
		assert.equal(store.get()?.moduleId, OUTDOOR_ID, "a push does not move");
	});

	it("only this dial: own module and own value; turning changes only its value", async () => {
		const { dials, store, writes } = setup();
		const dial = await dialOf(dials, "value", { followFocus: false, moduleKey: makeModuleKey(STATION_ID, BASE_ID) });
		const focusBefore = store.get();
		const writesBefore = writes.length;
		dials.rotate(dial.id, 1);
		assert.equal(title(dial), "Humidity");
		store.set({ ...here, moduleId: OUTDOOR_ID, metric: "co2" });
		assert.equal(title(dial), "Humidity", "the focus does not move it");
		assert.equal(value(dial), "45%");
		await settle(40);
		assert.equal(dial.settingsWrites.at(-1)?.metric, "humidity");
		assert.equal(writes.length, writesBefore + 1, "only our own store.set above wrote the focus");
		assert.notDeepEqual(store.get(), focusBefore);
		dials.rotate(dial.id, 1, true);
		assert.equal(value(dial), "80%", "turning while pushed: its own next sensor, same value");
	});

	it("a Value Dial never touches the focus in dial-only scope", async () => {
		const { dials, store, writes } = setup();
		const dial = await dialOf(dials, "value", { followFocus: false, moduleKey: makeModuleKey(STATION_ID, BASE_ID) });
		const before = store.get();
		dials.rotate(dial.id, 3);
		dials.rotate(dial.id, 1, true);
		dials.press(dial.id);
		await settle(40);
		assert.deepEqual(store.get(), before);
		assert.equal(writes.length, 0);
	});
});

describe("Custom Dial", () => {
	it("defaults: turn = value, turn while pushed = station, push = sensor (focus scope)", async () => {
		const { dials, store } = setup();
		const dial = await dialOf(dials, "custom");
		dials.rotate(dial.id, 1);
		assert.equal(store.get()?.metric, "humidity");
		dials.rotate(dial.id, 1, true);
		assert.equal(store.get()?.stationId, STATION_B_ID);
		dials.press(dial.id);
		assert.notEqual(store.get()?.moduleId, BASE_B_ID, "moved to another sensor of station B");
		assert.equal(store.get()?.stationId, STATION_B_ID);
	});

	it("an appear without a mode is the Custom Dial", async () => {
		const { dials, store } = setup();
		const dial = new RecordingDialSurface();
		await dials.appear(dial, {});
		dials.rotate(dial.id, 1);
		assert.equal(store.get()?.metric, "humidity");
	});

	it("maps each gesture from the settings", async () => {
		const { dials, source, store } = setup();
		const dial = await dialOf(dials, "custom", { dialRotate: "sensor", dialPressRotate: "value", dialPush: "reload" });
		dials.rotate(dial.id, 1);
		assert.equal(store.get()?.moduleId, OUTDOOR_ID, "turn = sensor");
		dials.rotate(dial.id, 1, true);
		assert.equal(store.get()?.metric, "humidity", "turn while pushed = value");
		dials.press(dial.id);
		assert.equal(source.refreshCalls, 1, "push = reload");
		assert.equal(store.get()?.metric, "humidity");
	});

	it("'none' does nothing and 'reload' on a turn reloads", async () => {
		const { dials, source, store } = setup();
		const dial = await dialOf(dials, "custom", { dialRotate: "none", dialPressRotate: "reload", dialPush: "none" });
		const before = store.get();
		const n = dial.feedback.length;
		dials.rotate(dial.id, 2);
		dials.press(dial.id);
		assert.equal(source.refreshCalls, 0);
		assert.deepEqual(store.get(), before);
		assert.equal(dial.feedback.length, n);
		dials.rotate(dial.id, 1, true);
		assert.equal(source.refreshCalls, 1);
		assert.deepEqual(store.get(), before);
	});

	it("a pushed turn does not also count as a push", async () => {
		const { dials, source } = setup();
		const dial = await dialOf(dials, "custom", { dialPush: "reload" });
		dials.down(dial.id);
		dials.rotate(dial.id, 1, true);
		dials.up(dial.id);
		assert.equal(source.refreshCalls, 0);
	});

	it("only this dial: the mapped gestures change only the dial", async () => {
		const { dials, store, writes } = setup();
		const dial = await dialOf(dials, "custom", { followFocus: false, moduleKey: makeModuleKey(STATION_ID, BASE_ID), dialRotate: "sensor" });
		const before = store.get();
		dials.rotate(dial.id, 1);
		assert.equal(value(dial), "8.4°C");
		await settle(40);
		assert.deepEqual(store.get(), before);
		assert.equal(writes.length, 0);
		assert.equal(dial.settingsWrites.at(-1)?.moduleKey, makeModuleKey(STATION_ID, OUTDOOR_ID));
	});
});

describe("tap and long touch on every dial", () => {
	for (const mode of ["sensor", "value", "custom"] as const) {
		for (const followFocus of [true, false]) {
			it(`${mode}, followFocus ${followFocus}: tap reloads, hold cycles value -> min/max -> history`, async () => {
				const { dials, source, store } = setup();
				const dial = await dialOf(dials, mode, { followFocus, moduleKey: makeModuleKey(STATION_ID, BASE_ID) });
				const before = store.get();
				dials.tap(dial.id);
				assert.equal(source.refreshCalls, 1);
				dials.hold(dial.id);
				assert.equal(value(dial), "↓19.2°C ↑22.8°C");
				dials.hold(dial.id);
				assert.equal(dial.layouts.at(-1), "layouts/history-strip.json");
				dials.hold(dial.id);
				assert.equal(value(dial), "21.4°C");
				assert.deepEqual(store.get(), before);
			});
		}
	}
});

describe("the Sensor Dial's metric list in the Property Inspector", () => {
	it("offers every display metric and presets temperature, the other dials neither", async () => {
		const { dials } = setup();
		await dialOf(dials, "sensor", {}, "pi-sensor");
		await dialOf(dials, "value", {}, "pi-value");
		await dialOf(dials, "custom", {}, "pi-custom");
		assert.equal(isRememberedAllMetricsAction("pi-sensor"), true);
		assert.equal(isRememberedAllMetricsAction("pi-value"), false);
		assert.equal(isRememberedAllMetricsAction("pi-custom"), false);
		assert.equal(getRememberedDefaultMetric("pi-sensor"), "temperature");
		assert.equal(getRememberedDefaultMetric("pi-value"), undefined);
	});
});

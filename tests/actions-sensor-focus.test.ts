/**
 * The sensor focus key: follows the focus's station and sensor, shows the metric of its OWN
 * settings, and ignores the focus's metric. The focus display (sensor AND value) is the foil.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isRememberedAllMetricsAction } from "../src/actions/global-settings.ts";
import { KeyController } from "../src/actions/key-controller.ts";
import { createPiRouter } from "../src/actions/pi-router.ts";
import type { Focus } from "../src/focus/navigate.ts";
import { PI_EVENTS } from "../src/pi-protocol.ts";
import { makeModuleKey } from "../src/render/select.ts";
import {
	BASE_B_ID,
	BASE_ID,
	FakeService,
	FakeSource,
	makeEnv,
	makeFocusStore,
	makeTwoStationSnapshot,
	OUTDOOR_ID,
	RecordingKeySurface,
	STATION_B_ID,
	STATION_ID,
} from "./actions-fixtures.ts";

const here: Focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" };
const SENSOR = { metric: "temperature", follow: "sensor" } as const;

function setup(focus: Focus = here) {
	const source = new FakeSource(makeTwoStationSnapshot());
	const f = makeFocusStore(focus);
	const env = makeEnv(source, { focus: f.store, debounceMs: 5 });
	return { source, ...f, env, keys: new KeyController({ ...env, overlayMs: 30 }) };
}

describe("sensor focus key", () => {
	it("shows temperature when its settings pick no metric", async () => {
		const { keys } = setup();
		const key = new RecordingKeySurface("sf");
		await keys.appear(key, {}, SENSOR);
		assert.match(key.lastTitle ?? "", /^21\.4°C/);
	});

	it("keeps its own metric (humidity) when the focus metric moves", async () => {
		const { keys, store } = setup();
		const key = new RecordingKeySurface("sf");
		await keys.appear(key, { metric: "humidity" }, SENSOR);
		const before = key.lastTitle;
		assert.match(before ?? "", /%/);
		for (const metric of ["co2", "pressure", "temperature", "noise"] as const) {
			store.set({ ...here, metric });
			assert.equal(key.lastTitle, before, `focus on ${metric}: still the same humidity`);
		}
	});

	it("follows the sensor and the station of the focus", async () => {
		const { keys, store } = setup();
		const key = new RecordingKeySurface("sf");
		await keys.appear(key, { metric: "humidity" }, SENSOR);
		store.set({ ...here, moduleId: OUTDOOR_ID });
		assert.match(key.lastTitle ?? "", /^80\s*%\nGarden/, "next sensor: the outdoor module");
		store.set({ stationId: STATION_B_ID, moduleId: BASE_B_ID, metric: "temperature" });
		assert.match(key.lastTitle ?? "", /^55\s*%\nAttic/, "next station");
	});

	it("shows 'No data' where the focused sensor lacks the value, and not another value", async () => {
		const { keys, store } = setup();
		const key = new RecordingKeySurface("sf");
		await keys.appear(key, { metric: "co2" }, SENSOR);
		assert.match(key.lastTitle ?? "", /^612\s+ppm/);
		store.set({ ...here, moduleId: OUTDOOR_ID });
		assert.match(key.lastTitle ?? "", /^No\s+data/i);
		assert.doesNotMatch(key.lastTitle ?? "", /°C|%|ppm/);
	});

	it("applies its alert thresholds (same metric, same unit), unlike the focus display", async () => {
		const { keys } = setup();
		const plain = new RecordingKeySurface("plain");
		const alerting = new RecordingKeySurface("alerting");
		const display = new RecordingKeySurface("display");
		const displayAlerting = new RecordingKeySurface("displayAlerting");
		await keys.appear(plain, { metric: "co2" }, SENSOR);
		await keys.appear(alerting, { metric: "co2", alertAbove: 100 }, SENSOR);
		await keys.appear(display, {}, { metric: "temperature", follow: true });
		await keys.appear(displayAlerting, { alertAbove: 1 }, { metric: "temperature", follow: true });
		assert.notEqual(plain.lastImage, alerting.lastImage, "612 ppm is above 100: alert colour");
		assert.equal(display.lastImage, displayAlerting.lastImage, "the foil: the focus display ignores thresholds");
	});

	it("ignores a stored moduleKey: the focus decides", async () => {
		const { keys } = setup();
		const stale = new RecordingKeySurface("stale");
		await keys.appear(stale, { metric: "temperature", moduleKey: makeModuleKey(STATION_B_ID, BASE_B_ID) }, SENSOR);
		assert.match(stale.lastTitle ?? "", /^21\.4°C/, "the focus is on the first station's base module, not the stored Attic");
	});

	it("never writes settings, not even on first use without a module", async () => {
		const { keys, store } = setup();
		const key = new RecordingKeySurface("sf");
		await keys.appear(key, {}, SENSOR);
		store.set({ ...here, moduleId: OUTDOOR_ID });
		assert.equal(key.settingsWrites.length, 0, "a fixed key without a module would adopt one; this one must not");
	});

	it("a press refreshes, and temperature shows the minimum and maximum", async () => {
		const { keys, source } = setup();
		const key = new RecordingKeySurface("sf");
		await keys.appear(key, {}, SENSOR);
		const before = key.lastTitle;
		keys.press(key.id);
		assert.equal(source.refreshCalls, 1);
		assert.notEqual(key.lastTitle, before, "min/max overlay");
		const humidity = new RecordingKeySurface("h");
		await keys.appear(humidity, { metric: "humidity" }, SENSOR);
		const n = humidity.titles.length;
		keys.press(humidity.id);
		assert.equal(humidity.titles.length, n, "humidity has no extremes");
	});

	it("the Next/Previous Value state of the focus display still moves it (the difference)", async () => {
		const { keys, store } = setup();
		const display = new RecordingKeySurface("display");
		await keys.appear(display, {}, { metric: "temperature", follow: true });
		store.set({ ...here, metric: "humidity" });
		assert.match(display.lastTitle ?? "", /%/);
	});
});

describe("sensor focus metric dropdown", () => {
	it("offers ALL display metrics even where the focused sensor reports few, and forgets on disappear", async () => {
		const { keys, env } = setup({ stationId: STATION_ID, moduleId: OUTDOOR_ID, metric: "temperature" });
		const key = new RecordingKeySurface("sf-1");
		const other = new RecordingKeySurface("co2-1");
		await keys.appear(key, { moduleKey: makeModuleKey(STATION_ID, OUTDOOR_ID) }, SENSOR);
		await keys.appear(other, { moduleKey: makeModuleKey(STATION_ID, OUTDOOR_ID) }, "temperature");
		assert.equal(isRememberedAllMetricsAction("sf-1"), true);
		assert.equal(isRememberedAllMetricsAction("co2-1"), false);
		const sent: Array<Record<string, unknown>> = [];
		const router = createPiRouter({
			getService: () => new FakeService(makeTwoStationSnapshot()),
			reply: async (m) => void sent.push({ ...m }),
			openUrl: async () => {},
			getActionSettings: () => ({ moduleKey: makeModuleKey(STATION_ID, OUTDOOR_ID) }),
			isAllMetricsAction: isRememberedAllMetricsAction,
			getGlobal: () => ({}),
			updateGlobal: async () => {},
			logger: env.logger,
		});
		const values = () => (sent[sent.length - 1] as { items: Array<{ value: string }> }).items.map((i) => i.value);
		await router.handle("sf-1", { event: PI_EVENTS.getMetrics });
		assert.ok(values().includes("co2") && values().includes("wind") && values().includes("absolutePressure"));
		await router.handle("co2-1", { event: PI_EVENTS.getMetrics });
		assert.equal(values().includes("co2"), false, "the outdoor module has no CO2: a normal key lists what its module reports");
		keys.disappear("sf-1");
		assert.equal(isRememberedAllMetricsAction("sf-1"), false);
		keys.dispose();
	});
});

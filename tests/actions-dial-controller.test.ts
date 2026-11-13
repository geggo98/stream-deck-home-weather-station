/** The dial behaviour with a fake source: rotate, push, tap, hold, persistence, cleanup. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DialController } from "../src/actions/dial-controller.ts";
import { makeModuleKey } from "../src/render/select.ts";
import {
	baseModule,
	BASE_ID,
	FakeSource,
	makeEnv,
	makeSnapshot,
	OUTDOOR_ID,
	RAIN_ID,
	WIND_ID,
	RecordingDialSurface,
	settle,
	STATION_ID,
} from "./actions-fixtures.ts";

const BASE_KEY = makeModuleKey(STATION_ID, BASE_ID);

function setup(source: FakeSource | undefined) {
	const env = makeEnv(source);
	return { env, controller: new DialController({ ...env, persistMs: 15 }) };
}

const title = (d: RecordingDialSurface) => d.last?.title.value;
const value = (d: RecordingDialSurface) => d.last?.value.value;

describe("DialController", () => {
	it("starts on the first measurement the module reports", async () => {
		const { controller } = setup(new FakeSource(makeSnapshot()));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY });
		assert.equal(title(dial), "Temperature");
		assert.equal(value(dial), "21.4°C");
	});

	it("rotates through exactly the metrics the module reports, both ways, and wraps", async () => {
		const { controller } = setup(new FakeSource(makeSnapshot()));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY });
		const seen: string[] = [];
		for (let i = 0; i < 6; i++) {
			controller.rotate(dial.id, 1);
			seen.push(title(dial)!);
		}
		// base station: temperature, humidity, co2, noise, pressure, station pressure (then wraps)
		assert.deepEqual(seen, ["Humidity", "CO2", "Noise", "Pressure", "Station pressure", "Temperature"]);
		controller.rotate(dial.id, -1);
		assert.equal(title(dial), "Station pressure", "counter-clockwise goes back, wrapping");
		controller.rotate(dial.id, 3);
		assert.equal(title(dial), "CO2");
	});

	it("never offers a metric the module does not have (rain module)", async () => {
		const { controller } = setup(new FakeSource(makeSnapshot()));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: makeModuleKey(STATION_ID, RAIN_ID) });
		const seen = new Set<string>();
		for (let i = 0; i < 8; i++) {
			seen.add(title(dial)!);
			controller.rotate(dial.id, 1);
		}
		assert.deepEqual([...seen].sort(), ["Rain 1 h", "Rain 24 h", "Rain now"]);
	});

	it("ignores rotation without data, with no ticks, and for unknown actions", async () => {
		const { controller } = setup(new FakeSource(undefined));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY });
		const n = dial.feedback.length;
		controller.rotate(dial.id, 1);
		controller.rotate("nope", 1);
		controller.rotate(dial.id, 0);
		assert.equal(dial.feedback.length, n);
	});

	it("persists the face after a quiet period, once, and does not undo it on the echo", async () => {
		const { controller } = setup(new FakeSource(makeSnapshot()));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY });
		controller.rotate(dial.id, 1);
		controller.rotate(dial.id, 1);
		assert.equal(dial.settingsWrites.length, 0, "not on every tick");
		await settle(40);
		assert.equal(dial.settingsWrites.length, 1);
		assert.equal(dial.settingsWrites[0]?.metric, "co2");
		// Rotate again, then the (older) echo of the first write arrives.
		controller.rotate(dial.id, 1);
		controller.settingsChanged(dial.id, { moduleKey: BASE_KEY, metric: "co2" });
		await settle(20);
		assert.equal(title(dial), "Noise", "the echo did not drag the face back");
	});

	it("restores a persisted face on appear and follows a PI change", async () => {
		const { controller } = setup(new FakeSource(makeSnapshot()));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY, metric: "pressure" });
		assert.equal(title(dial), "Pressure");
		controller.settingsChanged(dial.id, { moduleKey: BASE_KEY, metric: "humidity" });
		await settle(20);
		assert.equal(title(dial), "Humidity");
	});

	it("a long touch cycles value, min/max, history and back; rotation resets it", async () => {
		const { controller } = setup(new FakeSource(makeSnapshot()));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY });
		controller.hold(dial.id);
		assert.equal(value(dial), "↓19.2°C ↑22.8°C");
		controller.hold(dial.id);
		assert.equal(dial.layouts.at(-1), "layouts/history-strip.json", "temperature has a history strip");
		controller.hold(dial.id);
		assert.equal(dial.layouts.at(-1), "$B1");
		assert.equal(value(dial), "21.4°C");
		controller.hold(dial.id);
		controller.rotate(dial.id, 1);
		controller.rotate(dial.id, -1);
		assert.equal(value(dial), "21.4°C");
	});

	it("a tap asks for a refresh and nothing else; a push is the next sensor, not a refresh", async () => {
		const source = new FakeSource(makeSnapshot());
		const { controller } = setup(source);
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY, followFocus: false });
		const n = dial.feedback.length;
		controller.tap(dial.id);
		controller.tap("nope");
		assert.equal(source.refreshCalls, 1);
		assert.equal(dial.feedback.length, n);
		controller.press(dial.id);
		assert.equal(source.refreshCalls, 1, "a push does not reload");
		assert.equal(title(dial), "Temperature");
		assert.equal(value(dial), "8.4°C", "the outdoor sensor reports temperature too");
	});

	it("adopts the base station for a fresh dial and follows status changes", async () => {
		const source = new FakeSource(makeSnapshot());
		const { controller } = setup(source);
		const dial = new RecordingDialSurface();
		await controller.appear(dial, {});
		assert.equal(dial.settingsWrites[0]?.moduleKey, BASE_KEY);
		source.emit({ state: { kind: "auth-error", message: "x", since: 0 } });
		assert.equal(value(dial), "Sign in");
		source.emit({ state: { kind: "ok" } });
		assert.equal(value(dial), "21.4°C");
	});

	it("de-duplicates identical feedback and cleans up on disappear", async () => {
		const source = new FakeSource(makeSnapshot());
		const { controller } = setup(source);
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY });
		const n = dial.feedback.length;
		source.emit();
		source.emit({ snapshot: makeSnapshot([baseModule(), baseModule({ id: OUTDOOR_ID })]) });
		assert.equal(dial.feedback.length, n);
		controller.disappear(dial.id);
		assert.equal(source.listeners.size, 0);
		controller.rotate(dial.id, 1);
		assert.equal(dial.feedback.length, n);
	});
});

describe("DialController: a face the module does not report", () => {
	const WIND_KEY = makeModuleKey(STATION_ID, WIND_ID);

	it("switching the module in the PI drops a remembered face the new module lacks", async () => {
		// Before the fix the dial stayed on "CO2 / No data" after the switch and the first
		// rotation skipped the wind module's first measurement.
		const { controller } = setup(new FakeSource(makeSnapshot()));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY, metric: "co2" });
		assert.equal(title(dial), "CO2");
		controller.settingsChanged(dial.id, { moduleKey: WIND_KEY, metric: "co2" });
		await settle(60);
		assert.equal(title(dial), "Wind", "falls back to the module's first measurement");
		assert.equal(value(dial), "18\u00a0km/h");
		controller.rotate(dial.id, 1);
		assert.equal(title(dial), "Gusts", "the first rotation goes to the second measurement, not past it");
		// the reset is persisted: no stale co2 comes back on the next appear
		await settle(40);
		assert.ok(dial.settingsWrites.length >= 1);
		assert.equal(dial.settingsWrites.at(-1)?.moduleKey, WIND_KEY);
	});

	it("keeps the face when the new module reports it", async () => {
		const { controller } = setup(new FakeSource(makeSnapshot([baseModule(), baseModule({ id: "00:00:5e:00:53:99", name: "Bedroom" })])));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: BASE_KEY, metric: "co2" });
		controller.settingsChanged(dial.id, { moduleKey: makeModuleKey(STATION_ID, "00:00:5e:00:53:99"), metric: "co2" });
		await settle(60);
		assert.equal(title(dial), "CO2");
	});

	it("a face that is not in the list counts as before the list for a step forward", async () => {
		// Opened with metric "co2" on a wind module (no switch event): the old code treated
		// the unknown face as index 0, so +1 landed on index 1 and skipped the first entry.
		const { controller } = setup(new FakeSource(makeSnapshot()));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: WIND_KEY, metric: "co2" });
		assert.equal(value(dial), "No data");
		controller.rotate(dial.id, 1);
		assert.equal(title(dial), "Wind");
		controller.rotate(dial.id, 1);
		assert.equal(title(dial), "Gusts");
	});

	it("a face that is not in the list counts as the start for a step back", async () => {
		const { controller } = setup(new FakeSource(makeSnapshot()));
		const dial = new RecordingDialSurface();
		await controller.appear(dial, { moduleKey: WIND_KEY, metric: "co2" });
		controller.rotate(dial.id, -1);
		assert.equal(title(dial), "Gusts", "wraps to the last entry");
	});
});

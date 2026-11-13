/** Auto rotate: one shared timer that exists only while the state is on and a key is visible. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AutoRotator } from "../src/focus/auto-rotate.ts";
import { NavController } from "../src/actions/nav-controller.ts";
import {
	BASE_ID,
	FakeSource,
	makeEnv,
	makeFocusStore,
	makeSnapshot,
	RecordingKeySurface,
	settle,
	STATION_ID,
} from "./actions-fixtures.ts";

describe("AutoRotator", () => {
	it("has no timer while off, none without a visible key, and one while on and visible", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		let ticks = 0;
		const rotator = new AutoRotator(() => ticks++);
		rotator.register("k1", 8, false);
		assert.equal(rotator.running, false, "off at start");
		rotator.toggle();
		assert.equal(rotator.running, true);
		assert.equal(rotator.intervalSeconds, 8);
		t.mock.timers.tick(7_999);
		assert.equal(ticks, 0);
		t.mock.timers.tick(1);
		assert.equal(ticks, 1);
		rotator.unregister("k1");
		assert.equal(rotator.running, false, "the last key left: timer cleared");
		t.mock.timers.tick(60_000);
		assert.equal(ticks, 1);
		rotator.register("k2", 8, false);
		assert.equal(rotator.running, true, "still on: a visible key brings the timer back");
		rotator.toggle();
		assert.equal(rotator.running, false);
	});

	it("shares ONE timer between keys, the shortest interval wins, bounds are 3..60", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		let ticks = 0;
		const rotator = new AutoRotator(() => ticks++);
		rotator.register("a", 30, false);
		rotator.register("b", 1, false);
		rotator.register("c", 500, false);
		rotator.toggle();
		assert.equal(rotator.intervalSeconds, 3);
		rotator.unregister("b");
		assert.equal(rotator.intervalSeconds, 30, "re-armed with the next shortest");
		t.mock.timers.tick(30_000);
		assert.equal(ticks, 1, "one tick per interval however many keys exist");
	});

	it("'start on' applies to a key that appears before anyone toggled, once", () => {
		const rotator = new AutoRotator(() => {});
		rotator.register("a", 8, true);
		assert.equal(rotator.isOn, true);
		rotator.toggle();
		rotator.unregister("a");
		rotator.register("a", 8, true);
		assert.equal(rotator.isOn, false, "the user switched it off: appearing again does not switch it on");
		rotator.dispose();
	});

	it("the timer never keeps the process alive", () => {
		const rotator = new AutoRotator(() => {});
		rotator.register("a", 8, true);
		assert.equal(rotator.running, true);
		assert.equal(rotator.timerKeepsProcessAlive, false);
		rotator.dispose();
		assert.equal(rotator.running, false);
	});

	it("a failing tick does not stop the rotation", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		let ticks = 0;
		const rotator = new AutoRotator(() => {
			ticks++;
			throw new Error("boom");
		});
		rotator.register("a", 3, true);
		t.mock.timers.tick(9_000);
		assert.equal(ticks, 3);
		rotator.dispose();
	});
});

describe("auto-rotate key", () => {
	function setup() {
		const source = new FakeSource(makeSnapshot());
		const focus = makeFocusStore({ stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" });
		const controller = new NavController(makeEnv(source, { focus: focus.store }));
		return { source, focus, controller };
	}

	it("advances the focus through the focused sensor's values while on, and stops on toggle", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const { focus, controller } = setup();
		const key = new RecordingKeySurface("rot");
		await controller.appear(key, { autoRotateSeconds: 4 }, "auto-rotate");
		assert.equal(controller.rotator.running, false);
		assert.equal(key.lastTitle, "Off");
		controller.press(key.id);
		assert.equal(key.lastTitle, "On\n4 s");
		t.mock.timers.tick(4_000);
		assert.equal(focus.store.get()?.metric, "humidity");
		t.mock.timers.tick(8_000);
		assert.equal(focus.store.get()?.metric, "noise");
		controller.press(key.id);
		t.mock.timers.tick(60_000);
		assert.equal(focus.store.get()?.metric, "noise", "off: no more steps");
		assert.equal(controller.rotator.running, false);
		controller.dispose();
	});

	it("clears the timer when the key disappears, and starts on when asked to", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const { controller } = setup();
		const key = new RecordingKeySurface("rot");
		await controller.appear(key, { autoRotateStartOn: true }, "auto-rotate");
		assert.equal(controller.rotator.running, true);
		assert.equal(key.lastTitle, "On\n8 s");
		controller.disappear(key.id);
		assert.equal(controller.rotator.running, false);
		controller.dispose();
	});

	it("a changed interval re-arms the shared timer", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const { controller } = setup();
		const key = new RecordingKeySurface("rot");
		await controller.appear(key, { autoRotateStartOn: true, autoRotateSeconds: 10 }, "auto-rotate");
		assert.equal(controller.rotator.intervalSeconds, 10);
		controller.settingsChanged(key.id, { autoRotateStartOn: true, autoRotateSeconds: "5" as never });
		await settle(30); // the debounced re-bind uses a real (un-mocked) setTimeout
		assert.equal(controller.rotator.intervalSeconds, 5);
		controller.dispose();
	});
});

/**
 * Clock-driven repaint: a reading turns stale and its age hint grows with the CLOCK, not
 * with a poll, so visible actions repaint on a shared low-frequency timer that exists only
 * while something is visible. Mock timers drive the interval; nothing sleeps.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DialController } from "../src/actions/dial-controller.ts";
import { KeyController } from "../src/actions/key-controller.ts";
import { REPAINT_INTERVAL_MS, RepaintClock } from "../src/actions/repaint-clock.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { STALE_AFTER_MS } from "../src/render/status.ts";
import {
	BASE_ID,
	FakeSource,
	makeEnv,
	makeSnapshot,
	MIN,
	NOW,
	RecordingDialSurface,
	RecordingKeySurface,
	STATION_ID,
} from "./actions-fixtures.ts";

const BASE_KEY = makeModuleKey(STATION_ID, BASE_ID);

describe("RepaintClock", () => {
	it("has no timer until someone listens, and none again after the last one leaves", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const clock = new RepaintClock();
		assert.equal(clock.running, false);
		const offA = clock.subscribe(() => {});
		const offB = clock.subscribe(() => {});
		assert.equal(clock.running, true);
		offA();
		assert.equal(clock.running, true, "one listener left");
		offB();
		assert.equal(clock.running, false, "cleared on the last unsubscribe");
	});

	it("ticks every minute by default and survives a listener that throws", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const clock = new RepaintClock();
		let ticks = 0;
		clock.subscribe(() => {
			throw new Error("boom");
		});
		clock.subscribe(() => void ticks++);
		t.mock.timers.tick(REPAINT_INTERVAL_MS - 1);
		assert.equal(ticks, 0);
		t.mock.timers.tick(1);
		assert.equal(ticks, 1);
		t.mock.timers.tick(REPAINT_INTERVAL_MS);
		assert.equal(ticks, 2);
		assert.equal(REPAINT_INTERVAL_MS, 60_000);
	});

	it("does not keep the process alive (the interval is unref'd)", () => {
		const clock = new RepaintClock(10_000);
		const off = clock.subscribe(() => {});
		// A ref'd 10 s interval would hold this test process open; the runner finishing on
		// its own is the proof, hasRef() the direct check.
		const timer = (clock as unknown as { timer: { hasRef(): boolean } }).timer;
		assert.equal(timer.hasRef(), false);
		off();
	});
});

describe("clock-driven repaint of keys", () => {
	it("shows staleness without any poll or status event", async (t) => {
		// Without the clock subscription in ControllerBase nothing repaints between polls, and
		// the key keeps showing a fresh reading after the sensor went quiet.
		t.mock.timers.enable({ apis: ["setInterval"] });
		let now = NOW;
		const source = new FakeSource(makeSnapshot());
		const clock = new RepaintClock();
		const controller = new KeyController({ ...makeEnv(source, { now: () => now, clock }), overlayMs: 30 });
		const key = new RecordingKeySurface();
		await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
		assert.equal(key.lastTitle, "21.4°C\nLiving…", "fresh: module name on the second line");
		const writesBefore = key.titles.length;

		// The base module was measured 2 min before NOW; this is 30 min later, past the 25 min threshold.
		now = NOW + 30 * MIN;
		assert.ok(now - (NOW - 2 * MIN) > STALE_AFTER_MS);
		t.mock.timers.tick(REPAINT_INTERVAL_MS);
		assert.equal(key.lastTitle, "21.4°C\n32 min", "stale: age hint appears");
		assert.equal(key.titles.length, writesBefore + 1);
		assert.equal(source.refreshCalls, 0, "no request was needed for this");

		// A tick that changes nothing writes nothing.
		const images = key.images.length;
		now += MIN;
		t.mock.timers.tick(REPAINT_INTERVAL_MS);
		assert.equal(key.images.length, images, "the image is identical, so it is not written again");
		assert.equal(key.lastTitle, "21.4°C\n33 min", "while the age hint keeps counting");
		controller.dispose();
	});

	it("keeps one timer for key and dial together and clears it with the last action", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const source = new FakeSource(makeSnapshot());
		const clock = new RepaintClock();
		const env = makeEnv(source, { clock });
		const keys = new KeyController(env);
		const dials = new DialController(env);
		const key = new RecordingKeySurface("k1");
		const dial = new RecordingDialSurface("d1");
		assert.equal(clock.running, false, "nothing visible, no timer");
		await keys.appear(key, { moduleKey: BASE_KEY }, "temperature");
		await dials.appear(dial, { moduleKey: BASE_KEY });
		assert.equal(clock.running, true);
		keys.disappear("k1");
		assert.equal(clock.running, true, "the dial is still visible");
		dials.disappear("d1");
		assert.equal(clock.running, false, "last action gone: timer cleared");
		// and it comes back for the next appearance
		await keys.appear(key, { moduleKey: BASE_KEY }, "temperature");
		assert.equal(clock.running, true);
		keys.dispose();
		assert.equal(clock.running, false);
		dials.dispose();
	});

	it("re-appearing the same action does not leak a second subscription", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const clock = new RepaintClock();
		const keys = new KeyController(makeEnv(new FakeSource(makeSnapshot()), { clock }));
		const key = new RecordingKeySurface("k1");
		await keys.appear(key, { moduleKey: BASE_KEY }, "temperature");
		await keys.appear(key, { moduleKey: BASE_KEY }, "temperature");
		keys.disappear("k1");
		assert.equal(clock.running, false);
	});
});

describe("clock-driven repaint of the dial", () => {
	it("dims the strip and adds the age once the reading is stale", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		let now = NOW;
		const clock = new RepaintClock();
		const dials = new DialController({ ...makeEnv(new FakeSource(makeSnapshot()), { now: () => now, clock }), persistMs: 15 });
		const dial = new RecordingDialSurface();
		await dials.appear(dial, { moduleKey: BASE_KEY });
		assert.equal(dial.last?.title.opacity, 1);
		now = NOW + 30 * MIN;
		t.mock.timers.tick(REPAINT_INTERVAL_MS);
		assert.equal(dial.last?.title.value, "Temperature · 32 min");
		assert.ok((dial.last?.title.opacity ?? 1) < 1);
		dials.dispose();
	});
});

describe("a rejected write is retried", () => {
	it("setImage and setTitle are written again on the next tick after a rejection", async (t) => {
		// Without the onError hook the controller believes the failed write succeeded and
		// never repeats it until the content changes.
		t.mock.timers.enable({ apis: ["setInterval"] });
		const clock = new RepaintClock();
		const env = makeEnv(new FakeSource(makeSnapshot()), { clock });
		const controller = new KeyController(env);
		let failImage = true;
		let failTitle = true;
		const attempts = { image: 0, title: 0 };
		const key = new RecordingKeySurface();
		key.setImage = async () => {
			attempts.image++;
			if (failImage) throw new Error("socket closed");
		};
		key.setTitle = async () => {
			attempts.title++;
			if (failTitle) throw new Error("socket closed");
		};
		await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(attempts, { image: 1, title: 1 });
		assert.ok(env.logger.lines.some((l) => /setImage failed: socket closed/.test(l)));
		failImage = false;
		failTitle = false;
		t.mock.timers.tick(REPAINT_INTERVAL_MS);
		assert.deepEqual(attempts, { image: 2, title: 2 }, "both retried");
		t.mock.timers.tick(REPAINT_INTERVAL_MS);
		assert.deepEqual(attempts, { image: 2, title: 2 }, "and then left alone once they went through");
		controller.dispose();
	});

	it("the dial retries a rejected setFeedback", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const clock = new RepaintClock();
		const dials = new DialController(makeEnv(new FakeSource(makeSnapshot()), { clock }));
		const dial = new RecordingDialSurface();
		let calls = 0;
		let fail = true;
		dial.setFeedback = async () => {
			calls++;
			if (fail) throw new Error("socket closed");
		};
		await dials.appear(dial, { moduleKey: BASE_KEY });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls, 1);
		fail = false;
		t.mock.timers.tick(REPAINT_INTERVAL_MS);
		assert.equal(calls, 2);
		dials.dispose();
	});
});

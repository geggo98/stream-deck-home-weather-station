/** The history key: visible-only fetching, window cycling, states, repaint without refetching. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HistoryController } from "../src/actions/history-controller.ts";
import { HISTORY_REFRESH_MS, HISTORY_RETRY_MS } from "../src/actions/history-slot.ts";
import { DialController } from "../src/actions/dial-controller.ts";
import type { Focus } from "../src/focus/navigate.ts";
import { isSvgDataUri } from "../src/render/data-uri.ts";
import {
	BASE_B_ID,
	BASE_ID,
	decodeSvg,
	FakeService,
	makeEnv,
	makeFocusStore,
	makeSnapshot,
	makeTwoStationSnapshot,
	MIN,
	NOW,
	okHistory,
	RecordingDialSurface,
	RecordingKeySurface,
	settle,
	STATION_B_ID,
	STATION_ID,
} from "./actions-fixtures.ts";

const here: Focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" };

function setup(clock = { now: NOW }, snapshot = makeTwoStationSnapshot()) {
	const service = new FakeService(snapshot);
	const focus = makeFocusStore(here);
	const env = makeEnv(service, { focus: focus.store, now: () => clock.now });
	return { service, clock, ...focus, env, controller: new HistoryController(env) };
}

describe("history key", () => {
	it("shows Loading, asks for the focused module and metric once, then draws the curve", async () => {
		const { service, controller } = setup();
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		assert.equal(key.titles[0], "Loading");
		await settle();
		assert.deepEqual(service.historyCalls, [{ stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature", window: "24h" }]);
		assert.equal(key.lastTitle?.startsWith("24 h\n↓"), true, key.lastTitle);
		assert.ok(key.images.every((i) => i && isSvgDataUri(i)), "data URIs only");
		assert.match(decodeSvg(key.lastImage), /<path d="M/);
	});

	it("does not ask again for repaints, snapshot updates and the clock tick within the cache time", async () => {
		const { service, controller, clock } = setup();
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		await settle();
		service.emit();
		service.emit({ snapshot: makeTwoStationSnapshot() });
		clock.now += 5 * MIN;
		service.emit();
		await settle();
		assert.equal(service.historyCalls.length, 1);
		clock.now += HISTORY_REFRESH_MS;
		service.emit();
		await settle();
		assert.equal(service.historyCalls.length, 2, "asks again once the service's cache has expired");
	});

	it("keeps showing the old curve while a newer one loads (no flicker back to Loading)", async () => {
		const { service, controller, clock } = setup();
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		await settle();
		let open: () => void = () => {};
		service.historyGate = new Promise((resolve) => {
			open = resolve;
		});
		clock.now += HISTORY_REFRESH_MS;
		service.emit();
		assert.notEqual(key.lastTitle, "Loading");
		open();
		await settle();
	});

	it("retries an error after a minute, not on every repaint", async () => {
		const { service, controller, clock } = setup();
		service.historyAnswer = (request) => ({ kind: "error", request, message: "x", reason: "transient" });
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		await settle();
		assert.equal(key.lastTitle, "Offline");
		service.emit();
		service.emit();
		assert.equal(service.historyCalls.length, 1);
		clock.now += HISTORY_RETRY_MS;
		service.historyAnswer = undefined;
		service.emit();
		await settle();
		assert.equal(service.historyCalls.length, 2);
		assert.match(key.lastTitle ?? "", /^24 h/);
	});

	it("follows the focus: a new focus asks for the new module's history", async () => {
		const { service, controller, store } = setup();
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		await settle();
		store.set({ stationId: STATION_B_ID, moduleId: BASE_B_ID, metric: "humidity" });
		await settle();
		assert.deepEqual(service.historyCalls.at(-1), { stationId: STATION_B_ID, moduleId: BASE_B_ID, metric: "humidity", window: "24h" });
		store.set({ ...here, metric: "absolutePressure" });
		assert.equal(key.lastTitle, "No history", "station pressure has no history type");
		assert.equal(service.historyCalls.length, 2, "and nothing was asked for it");
	});

	it("with followFocus off it uses its own module and metric and ignores the focus", async () => {
		const { service, controller, store } = setup();
		const key = new RecordingKeySurface();
		await controller.appear(key, { followFocus: false, moduleKey: `${STATION_B_ID}|${BASE_B_ID}`, metric: "humidity" }, "temperature");
		await settle();
		store.set({ ...here, metric: "co2" });
		await settle();
		assert.deepEqual(service.historyCalls, [{ stationId: STATION_B_ID, moduleId: BASE_B_ID, metric: "humidity", window: "24h" }]);
	});

	it("cycles 24 h -> 3 days -> 6 h -> 24 h on press, remembers it, and ignores the echo of an older write", async () => {
		const { service, controller } = setup();
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		await settle();
		controller.press(key.id);
		await settle();
		assert.equal(service.historyCalls.at(-1)?.window, "3d");
		controller.press(key.id);
		await settle();
		assert.equal(service.historyCalls.at(-1)?.window, "6h");
		assert.deepEqual(key.settingsWrites.map((s) => s.historyWindow), ["3d", "6h"]);
		controller.settingsChanged(key.id, { historyWindow: "3d" }); // the older echo
		await settle(20);
		assert.equal(service.historyCalls.at(-1)?.window, "6h", "the older echo did not drag the window back");
		controller.press(key.id);
		await settle();
		assert.match(key.lastTitle ?? "", /^24 h/, "the 24 h result is still cached, so back to it needs no new request");
	});

	it("starts in the window of its settings, junk falls back to 24 h", async () => {
		const { service, controller } = setup();
		await controller.appear(new RecordingKeySurface("a"), { historyWindow: "6h" }, "temperature");
		await controller.appear(new RecordingKeySurface("b"), { historyWindow: "forever" as never }, "temperature");
		await settle();
		assert.deepEqual(service.historyCalls.map((c) => c.window).sort(), ["24h", "6h"]);
	});

	it("only requests while visible: nothing after disappear, even for an answer still in flight", async () => {
		const { service, controller, store } = setup();
		let open: () => void = () => {};
		service.historyGate = new Promise((resolve) => {
			open = resolve;
		});
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		assert.equal(service.historyCalls.length, 1);
		controller.disappear(key.id);
		const images = key.images.length;
		open();
		await settle();
		store.set({ ...here, metric: "humidity" });
		service.emit();
		await settle();
		assert.equal(service.historyCalls.length, 1, "no request for an invisible key");
		assert.equal(key.images.length, images, "and the late answer painted nothing");
	});

	it("does not ask while signed out, while loading, or without a service", async () => {
		const a = setup();
		a.service.state = { kind: "auth-error", message: "x", since: NOW };
		const key = new RecordingKeySurface();
		await a.controller.appear(key, {}, "temperature");
		assert.equal(key.lastTitle, "Sign in");
		const b = setup(undefined, makeSnapshot());
		b.service.snapshot = undefined;
		await b.controller.appear(new RecordingKeySurface(), {}, "temperature");
		const none = new HistoryController(makeEnv(undefined, { focus: b.store }));
		const orphan = new RecordingKeySurface();
		await none.appear(orphan, {}, "temperature");
		await settle();
		assert.equal(a.service.historyCalls.length + b.service.historyCalls.length, 0);
		assert.equal(orphan.lastTitle, "Offline");
	});

	it("survives a getHistory that rejects", async () => {
		const { service, controller, env } = setup();
		service.getHistory = () => Promise.reject(new Error("boom"));
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		await settle();
		assert.equal(key.lastTitle, "Offline");
		assert.ok(env.logger.lines.some((l) => l.includes("history request failed: boom")));
	});

	it("does not leak SVG markup to setImage", async () => {
		const { service, controller } = setup();
		service.historyAnswer = (r) => okHistory(r, []);
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		await settle();
		assert.equal(key.lastTitle, "No history");
		for (const image of key.images) assert.ok(image && isSvgDataUri(image));
	});
});

describe("dial history strip", () => {
	it("a long touch switches to the history layout, fetches history, and back to $B1", async () => {
		const service = new FakeService(makeTwoStationSnapshot());
		const focus = makeFocusStore(here);
		const dials = new DialController({ ...makeEnv(service, { focus: focus.store }), persistMs: 10 });
		const dial = new RecordingDialSurface();
		await dials.appear(dial, {});
		assert.equal(service.historyCalls.length, 0, "no history until the strip is shown");
		dials.hold(dial.id); // min/max
		assert.equal(service.historyCalls.length, 0);
		dials.hold(dial.id); // history
		await settle();
		assert.equal(dial.layouts.at(-1), "layouts/history-strip.json");
		assert.deepEqual(service.historyCalls, [{ stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature", window: "24h" }]);
		assert.ok(dial.lastStrip && isSvgDataUri(dial.lastStrip.chart.value));
		assert.match(dial.lastStrip?.value.value ?? "", /^24 h · ↓/);
		focus.store.set({ ...here, metric: "absolutePressure" });
		assert.equal(dial.layouts.at(-1), "$B1", "a value without history falls back to the normal strip");
		dials.dispose();
	});
});

describe("history slot cache and the askable rule", () => {
	it("going back to a previous focus shows its result at once, without Loading and without a new request", async () => {
		const { service, controller, store } = setup();
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		await settle();
		const first = key.lastTitle;
		store.set({ ...here, metric: "humidity" });
		await settle();
		const titles = key.titles.length;
		store.set(here);
		assert.equal(key.lastTitle, first, "the earlier curve is back immediately");
		assert.equal(key.titles.slice(titles).includes("Loading"), false);
		await settle();
		assert.equal(service.historyCalls.length, 2, "temperature once, humidity once");
	});

	it("the dial strip asks nothing while signed out, like the history key", async () => {
		const { service, env } = setup();
		service.state = { kind: "auth-error", message: "x", since: NOW };
		const dial = new RecordingDialSurface();
		const dials = new DialController({ ...env, persistMs: 10 });
		await dials.appear(dial, { moduleKey: `${STATION_ID}|${BASE_ID}`, followFocus: false });
		dials.hold(dial.id);
		dials.hold(dial.id);
		await settle();
		assert.equal(dial.layouts.at(-1), "layouts/history-strip.json");
		assert.deepEqual(service.historyCalls, []);
	});
});

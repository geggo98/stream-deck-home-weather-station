/** The navigation and utility keys, the focus display and the followers, with the two-station fixture. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DialController } from "../src/actions/dial-controller.ts";
import { KeyController } from "../src/actions/key-controller.ts";
import { NavController } from "../src/actions/nav-controller.ts";
import type { Focus } from "../src/focus/navigate.ts";
import type { NavKind } from "../src/render/nav-view.ts";
import {
	BASE_B_ID,
	BASE_ID,
	decodeSvg,
	FakeSource,
	makeEnv,
	makeFocusStore,
	makeSnapshot,
	makeTwoStationSnapshot,
	MIN,
	NOW,
	OUTDOOR_B_ID,
	OUTDOOR_ID,
	baseModule,
	RecordingDialSurface,
	RecordingKeySurface,
	settle,
	STATION_B_ID,
	STATION_ID,
} from "./actions-fixtures.ts";

const here: Focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" };

function setup(snapshot = makeTwoStationSnapshot(), focus: Focus | undefined = here) {
	const source = new FakeSource(snapshot);
	const f = makeFocusStore(focus);
	const env = makeEnv(source, { focus: f.store });
	return { source, ...f, env, nav: new NavController(env), keys: new KeyController(env), dials: new DialController({ ...env, persistMs: 10 }) };
}

async function key(nav: NavController, kind: NavKind, id: string = kind) {
	const surface = new RecordingKeySurface(id);
	await nav.appear(surface, {}, kind);
	return surface;
}

describe("navigation keys", () => {
	it("previews the target and moves the focus, persisted through the funnel", async () => {
		const { nav, store, writes } = setup();
		const next = await key(nav, "next-metric");
		const prev = await key(nav, "prev-metric");
		assert.equal(next.lastTitle, "→ Humidity");
		assert.equal(prev.lastTitle, "← Station pressure");
		nav.press(next.id);
		assert.equal(store.get()?.metric, "humidity");
		assert.equal(next.lastTitle, "→ CO2", "the preview follows the focus");
		assert.equal(prev.lastTitle, "← Temperature");
		await settle();
		assert.equal(writes.at(-1)?.focus && (writes.at(-1)?.focus as Focus).metric, "humidity");
	});

	it("next sensor keeps the metric and moves between the station's sensors", async () => {
		const { nav, store } = setup();
		const sensor = await key(nav, "next-sensor");
		assert.equal(sensor.lastTitle, "→ Garden");
		nav.press(sensor.id);
		assert.deepEqual(store.get(), { ...here, moduleId: OUTDOOR_ID });
		nav.press(sensor.id);
		assert.equal(store.get()?.moduleId, BASE_ID, "wraps");
	});

	it("next station and previous station land on the other station's base", async () => {
		const { nav, store } = setup();
		const next = await key(nav, "next-station");
		assert.equal(next.lastTitle, "→ Second S…");
		nav.press(next.id);
		assert.deepEqual(store.get(), { stationId: STATION_B_ID, moduleId: BASE_B_ID, metric: "temperature" });
		const prev = await key(nav, "prev-station");
		nav.press(prev.id);
		assert.equal(store.get()?.stationId, STATION_ID);
	});

	it("is dimmed and flashes the alert when there is nowhere to go (one station, one sensor)", async () => {
		const { nav, store, writes } = setup(makeSnapshot());
		const station = await key(nav, "next-station");
		assert.equal(station.lastTitle, "One station");
		assert.match(decodeSvg(station.lastImage), /<svg/);
		nav.press(station.id);
		assert.equal(station.alerts, 1);
		const sensor = await key(nav, "next-sensor");
		const co2 = { ...here, metric: "co2" as const };
		store.set(co2);
		assert.equal(sensor.lastTitle, "No other sensor", "only the base reports CO2");
		nav.press(sensor.id);
		assert.equal(sensor.alerts, 1);
		await settle();
		assert.deepEqual(store.get(), co2, "a blocked key changed nothing");
		assert.equal(writes.length, 1, "and wrote nothing");
	});

	it("repairs a stale stored focus on the first press instead of failing", async () => {
		const { nav, store } = setup(makeTwoStationSnapshot(), { stationId: STATION_ID, moduleId: "00:00:5e:00:53:99", metric: "temperature" });
		const next = await key(nav, "next-metric");
		nav.press(next.id);
		assert.deepEqual(store.get(), { ...here, metric: "humidity" });
	});

	it("shows status instead of navigation when signed out, and does not navigate", async () => {
		const { nav, store, source } = setup();
		const next = await key(nav, "next-metric");
		source.emit({ state: { kind: "auth-error", message: "x", since: NOW } });
		assert.equal(next.lastTitle, "Sign in");
		nav.press(next.id);
		assert.equal(store.get()?.metric, "temperature", "unchanged: a key showing a status does not navigate");
		assert.equal(next.alerts, 1);
	});
});

describe("reload key", () => {
	it("asks the source for the newest data, shows … meanwhile and the age afterwards", async () => {
		const { nav, source } = setup();
		let release: () => void = () => {};
		source.refresh = () => {
			source.refreshCalls++;
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		};
		const reload = await key(nav, "refresh");
		assert.equal(reload.lastTitle, "2 min", "age of the focused module's measurement");
		nav.press(reload.id);
		nav.press(reload.id);
		assert.equal(source.refreshCalls, 1, "a second press while one is in flight does nothing");
		assert.equal(reload.lastTitle, "…");
		release();
		await settle();
		assert.equal(reload.lastTitle, "2 min");
	});

	it("says 'just now' for a fresh reading and dims an old one", async () => {
		const fresh = setup(makeSnapshot([baseModule({ measuredAt: NOW - 20_000 })]));
		assert.equal((await key(fresh.nav, "refresh")).lastTitle, "just now");
		const old = setup(makeSnapshot([baseModule({ measuredAt: NOW - 40 * MIN })]));
		const reload = await key(old.nav, "refresh");
		assert.equal(reload.lastTitle, "40 min");
		assert.notEqual(decodeSvg(reload.lastImage), decodeSvg((await key(fresh.nav, "refresh", "other")).lastImage));
	});

	it("survives a refresh that rejects", async () => {
		const { nav, source, env } = setup();
		source.refresh = () => Promise.reject(new Error("offline"));
		const reload = await key(nav, "refresh");
		nav.press(reload.id);
		await settle();
		assert.equal(reload.lastTitle, "2 min");
		assert.ok(env.logger.lines.some((l) => l.includes("refresh failed: offline")));
	});
});

describe("info key", () => {
	it("cycles data age and battery, and flashes when only the age exists", async () => {
		const { nav, store } = setup();
		const info = await key(nav, "info");
		assert.equal(info.lastTitle, "2 min\nLiving r…");
		nav.press(info.id);
		assert.equal(info.alerts, 1, "the base station reports no battery: nothing to cycle to");
		store.set({ ...here, moduleId: OUTDOOR_ID });
		assert.equal(info.lastTitle, "3 min\nGarden");
		nav.press(info.id);
		assert.equal(info.lastTitle, "80 %\nGarden");
		nav.press(info.id);
		assert.equal(info.lastTitle, "3 min\nGarden", "and back");
	});
});

describe("followers repaint on a focus change, and nothing else does", () => {
	it("the focus display, a following measurement key, a following dial", async () => {
		const { keys, dials, store } = setup();
		const display = new RecordingKeySurface("display");
		await keys.appear(display, {}, { metric: "temperature", follow: true });
		const follower = new RecordingKeySurface("follower");
		await keys.appear(follower, { followFocus: true, alertAbove: 100 }, "co2");
		const fixed = new RecordingKeySurface("fixed");
		await keys.appear(fixed, {}, "humidity");
		const dial = new RecordingDialSurface("dial");
		await dials.appear(dial, {});
		assert.match(display.lastTitle ?? "", /^21\.4°C/);
		assert.match(follower.lastTitle ?? "", /^21\.4°C/, "a following key shows the focus, not its preset metric");
		assert.equal(dial.last?.value.value, "21.4°C");
		const fixedWrites = fixed.titles.length + fixed.images.length;

		store.set({ stationId: STATION_B_ID, moduleId: BASE_B_ID, metric: "humidity" });
		assert.match(display.lastTitle ?? "", /^55%\nAttic/);
		assert.match(follower.lastTitle ?? "", /^55%/);
		assert.equal(dial.last?.value.value, "55%");
		assert.equal(dial.last?.title.value, "Humidity");
		assert.equal(fixed.titles.length + fixed.images.length, fixedWrites, "a fixed-binding key is not a follower");
		assert.equal(display.settingsWrites.length + follower.settingsWrites.length, 0, "followers never adopt a module of their own");
	});

	it("stops reacting after it disappeared", async () => {
		const { keys, store } = setup();
		const display = new RecordingKeySurface("display");
		await keys.appear(display, {}, { metric: "temperature", follow: true });
		keys.disappear(display.id);
		const n = display.titles.length;
		store.set({ ...here, metric: "co2" });
		assert.equal(display.titles.length, n);
	});
});

describe("dial navigation", () => {
	it("rotate = value, push = sensor, rotate while pushed = station, on the focus", async () => {
		const { dials, store } = setup();
		const dial = new RecordingDialSurface("dial");
		await dials.appear(dial, {});
		dials.rotate(dial.id, 1);
		assert.equal(store.get()?.metric, "humidity");
		dials.rotate(dial.id, -2);
		assert.equal(store.get()?.metric, "absolutePressure", "two ticks back, wrapping");
		dials.rotate(dial.id, 1);
		dials.press(dial.id);
		assert.equal(store.get()?.moduleId, OUTDOOR_ID);
		dials.down(dial.id);
		dials.rotate(dial.id, 1, true);
		dials.up(dial.id);
		assert.equal(store.get()?.stationId, STATION_B_ID, "rotate while pushed switches the station");
		assert.equal(store.get()?.moduleId, BASE_B_ID);
		assert.equal(dial.last?.title.value, "Temperature");
	});

	it("a push that was part of 'rotate while pushed' does not also move the sensor", async () => {
		const { dials, store } = setup();
		const dial = new RecordingDialSurface("dial");
		await dials.appear(dial, {});
		dials.down(dial.id);
		dials.rotate(dial.id, 1, true);
		dials.up(dial.id);
		assert.equal(store.get()?.moduleId, BASE_B_ID);
		dials.down(dial.id);
		dials.up(dial.id);
		assert.equal(store.get()?.moduleId, OUTDOOR_B_ID, "a plain push is the next sensor");
	});

	it("a pinned dial navigates on its own and leaves the focus alone", async () => {
		const { dials, store, writes } = setup();
		const dial = new RecordingDialSurface("dial");
		await dials.appear(dial, { followFocus: false, moduleKey: `${STATION_ID}|${BASE_ID}` });
		dials.rotate(dial.id, 1);
		assert.equal(dial.last?.title.value, "Humidity");
		dials.press(dial.id);
		assert.equal(dial.last?.value.value, "80%", "outdoor humidity");
		dials.down(dial.id);
		dials.rotate(dial.id, 1, true);
		dials.up(dial.id);
		assert.equal(dial.last?.value.value, "55%", "station B's base humidity");
		assert.deepEqual(store.get(), here);
		assert.equal(writes.length, 0);
		await settle(40);
		assert.equal(dial.settingsWrites.at(-1)?.moduleKey, `${STATION_B_ID}|${BASE_B_ID}`);
		assert.equal(dial.settingsWrites.at(-1)?.metric, "humidity");
	});

	it("a tap reloads and a hold toggles; neither moves the focus", async () => {
		const { dials, store, source } = setup();
		const dial = new RecordingDialSurface("dial");
		await dials.appear(dial, {});
		dials.tap(dial.id);
		assert.equal(source.refreshCalls, 1);
		dials.hold(dial.id);
		assert.equal(dial.last?.value.value, "↓19.2°C ↑22.8°C");
		assert.deepEqual(store.get(), here);
	});
});

describe("auto rotate and the settings writes", () => {
	it("steps are not written one by one; the last value is written once when the rotation stops", async () => {
		const { nav, store, writes, source } = setup();
		const surface = await key(nav, "auto-rotate");
		await settle();
		const before = writes.length;
		let repaints = 0;
		store.subscribe(() => repaints++);
		nav.press(surface.id);
		assert.equal(nav.rotator.isOn, true);
		const start = store.get()?.metric;
		for (let i = 0; i < 5; i++) (nav.rotator as unknown as { tick(): void }).tick();
		await settle();
		assert.equal(repaints, 5, "every step still repaints the followers, once each");
		assert.notEqual(store.get()?.metric, start);
		assert.equal(writes.length, before, "no write while rotating");
		nav.press(surface.id);
		await settle();
		assert.equal(writes.length, before + 1, "one write when it stops");
		assert.equal((writes.at(-1)?.focus as Focus).metric, store.get()?.metric);
		void source;
	});
});

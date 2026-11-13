/**
 * The key behaviour with a fake WeatherSource and a recording surface: first-use
 * adoption, repaint-from-cache, status table end to end, image de-duplication, press
 * handling, bind generations and cleanup. No SDK is imported.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { KeyController } from "../src/actions/key-controller.ts";
import { MAX_CONTROLLED_ACTIONS } from "../src/actions/controller-base.ts";
import { getRememberedActionSettings } from "../src/actions/global-settings.ts";
import { isSvgDataUri } from "../src/render/data-uri.ts";
import { makeModuleKey } from "../src/render/select.ts";
import {
	baseModule,
	BASE_ID,
	decodeSvg,
	FakeSource,
	makeEnv,
	makeSnapshot,
	MIN,
	NOW,
	OUTDOOR_ID,
	RecordingKeySurface,
	settle,
	STATION_ID,
} from "./actions-fixtures.ts";

const BASE_KEY = makeModuleKey(STATION_ID, BASE_ID);

function setup(source: FakeSource | undefined, extra = {}) {
	const env = makeEnv(source, { debounceMs: 5, ...extra });
	const controller = new KeyController({ ...env, overlayMs: 30 });
	return { env, controller };
}

describe("KeyController", () => {
	it("paints from the cache on appear, through a data URI, and sets the title", async () => {
		const source = new FakeSource(makeSnapshot());
		const { controller } = setup(source);
		const key = new RecordingKeySurface();
		await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
		assert.equal(key.lastTitle, "21.4°C\nLiving r…");
		assert.ok(key.images.length >= 1);
		for (const image of key.images) assert.ok(image && isSvgDataUri(image), "setImage never gets a raw svg string");
		assert.match(decodeSvg(key.lastImage), /^<svg /);
	});

	it("shows 'Set up' without credentials and recovers by itself when they arrive", async () => {
		const source = new FakeSource(undefined);
		source.state = { kind: "no-credentials" };
		const { controller } = setup(source);
		const key = new RecordingKeySurface();
		await controller.appear(key, {}, "temperature");
		assert.equal(key.lastTitle, "Set up");
		source.emit({ snapshot: makeSnapshot(), state: { kind: "ok" } });
		assert.equal(key.lastTitle, "21.4°C\nLiving r…", "no second write path that could stick");
	});

	it("walks the status table: stale, unreachable, auth-error, back to fresh", async () => {
		const source = new FakeSource(makeSnapshot());
		const { controller } = setup(source);
		const key = new RecordingKeySurface();
		await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");

		source.emit({ snapshot: makeSnapshot([baseModule({ measuredAt: NOW - 30 * MIN })]) });
		assert.equal(key.lastTitle, "21.4°C\n30 min");

		source.emit({ snapshot: makeSnapshot([baseModule({ measuredAt: NOW - 120 * MIN, reachable: false })]) });
		assert.equal(key.lastTitle, "No signal");

		source.emit({ state: { kind: "auth-error", message: "revoked", since: NOW } });
		assert.equal(key.lastTitle, "Sign in");

		source.emit({ snapshot: makeSnapshot(), state: { kind: "ok" } });
		assert.equal(key.lastTitle, "21.4°C\nLiving r…");
	});

	it("does not rewrite image or title when nothing visible changed (de-duplication)", async () => {
		const source = new FakeSource(makeSnapshot());
		const { controller } = setup(source);
		const key = new RecordingKeySurface();
		await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
		const images = key.images.length;
		const titles = key.titles.length;
		// Same snapshot, jittering decimals below the displayed precision.
		source.emit({ snapshot: makeSnapshot([baseModule({ values: { ...baseModule().values, temperature: 21.41 } })]) });
		source.emit({ snapshot: makeSnapshot([baseModule({ values: { ...baseModule().values, temperature: 21.44 } })]) });
		assert.equal(key.images.length, images);
		assert.equal(key.titles.length, titles);
		source.emit({ snapshot: makeSnapshot([baseModule({ values: { ...baseModule().values, temperature: 22.9 } })]) });
		assert.equal(key.titles.length, titles + 1, "a visible change does write");
	});

	it("writes a title-less state once, so the user's own title is restored", async () => {
		const source = new FakeSource(makeSnapshot([baseModule({ name: "" })]));
		const { controller } = setup(source);
		const key = new RecordingKeySurface();
		await controller.appear(key, { moduleKey: BASE_KEY, bigText: true }, "temperature");
		assert.deepEqual(key.titles, [undefined]);
	});

	describe("first-use adoption", () => {
		it("adopts a module into its OWN settings, once, and only when unset", async () => {
			const source = new FakeSource(makeSnapshot());
			const { controller } = setup(source);
			const a = new RecordingKeySurface("a");
			const b = new RecordingKeySurface("b");
			await controller.appear(a, {}, "temperature");
			await controller.appear(b, { moduleKey: makeModuleKey(STATION_ID, OUTDOOR_ID) }, "temperature");
			assert.equal(a.settingsWrites.length, 1);
			assert.equal(a.settingsWrites[0]?.moduleKey, BASE_KEY);
			assert.equal(b.settingsWrites.length, 0, "a configured action is never touched");
			source.emit();
			assert.equal(a.settingsWrites.length, 1, "no repeated writes");
			assert.equal(getRememberedActionSettings("a")?.moduleKey, BASE_KEY);
		});

		it("waits for the first snapshot", async () => {
			const source = new FakeSource(undefined);
			source.state = { kind: "loading" };
			const { controller } = setup(source);
			const key = new RecordingKeySurface("late");
			await controller.appear(key, {}, "humidity");
			assert.equal(key.settingsWrites.length, 0);
			assert.equal(key.lastTitle, "…");
			source.emit({ snapshot: makeSnapshot() });
			assert.equal(key.settingsWrites[0]?.moduleKey, BASE_KEY);
			assert.equal(key.lastTitle, "45%\nLiving r…");
		});

		it("leaves a deliberately cleared module alone", async () => {
			const source = new FakeSource(makeSnapshot());
			const { controller } = setup(source);
			const key = new RecordingKeySurface();
			await controller.appear(key, { moduleKey: "" }, "temperature");
			assert.equal(key.settingsWrites.length, 0);
			assert.equal(key.lastTitle, "Pick module");
		});
	});

	describe("press", () => {
		it("requests a refresh and shows min/max for temperature for a short while", async () => {
			const source = new FakeSource(makeSnapshot());
			const { controller } = setup(source, { now: (() => { const t0 = Date.now(); return () => NOW + (Date.now() - t0); })() }); // a clock that really advances
			const key = new RecordingKeySurface();
			await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
			controller.press(key.id);
			assert.equal(source.refreshCalls, 1);
			assert.equal(key.lastTitle, "↑22.8°C\n↓19.2°C");
			await settle(80);
			assert.equal(key.lastTitle, "21.4°C\nLiving r…", "the overlay returned by itself");
		});

		it("refreshes but shows no overlay for metrics without extremes", async () => {
			const source = new FakeSource(makeSnapshot());
			const { controller } = setup(source);
			const key = new RecordingKeySurface();
			await controller.appear(key, { moduleKey: BASE_KEY }, "humidity");
			const titles = key.titles.length;
			controller.press(key.id);
			assert.equal(source.refreshCalls, 1);
			assert.equal(key.titles.length, titles);
		});

		it("does not let the overlay hide an outage", async () => {
			const source = new FakeSource(makeSnapshot());
			const { controller } = setup(source);
			const key = new RecordingKeySurface();
			await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
			source.emit({ state: { kind: "auth-error", message: "x", since: NOW } });
			controller.press(key.id);
			assert.equal(key.lastTitle, "Sign in");
		});

		it("survives a refresh that rejects", async () => {
			const source = new FakeSource(makeSnapshot());
			source.refresh = () => Promise.reject(new Error("boom"));
			const { controller, env } = setup(source);
			const key = new RecordingKeySurface();
			await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
			controller.press(key.id);
			await settle(5);
			assert.ok(env.logger.lines.some((l) => l.startsWith("error refresh failed: boom")));
		});
	});

	describe("settings, generations and cleanup", () => {
		it("re-binds debounced after a visible settings change, not for an identical echo", async () => {
			const source = new FakeSource(makeSnapshot());
			const { controller } = setup(source);
			const key = new RecordingKeySurface();
			await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
			const before = key.images.length;
			controller.settingsChanged(key.id, { moduleKey: BASE_KEY });
			await settle(20);
			assert.equal(key.images.length, before, "identical settings do nothing");
			controller.settingsChanged(key.id, { moduleKey: BASE_KEY, label: "T" });
			controller.settingsChanged(key.id, { moduleKey: BASE_KEY, label: "Te" });
			controller.settingsChanged(key.id, { moduleKey: BASE_KEY, label: "Tes" });
			await settle(30);
			assert.equal(key.lastTitle, "21.4°C\nTes", "only the last value bound");
		});

		it("a superseded bind goes quiet", async () => {
			const source = new FakeSource(makeSnapshot());
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const { controller } = setup(source, { waitForSettings: () => gate });
			const key = new RecordingKeySurface();
			const first = controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
			const second = controller.appear(key, { moduleKey: BASE_KEY, label: "New" }, "temperature");
			release();
			await Promise.all([first, second]);
			assert.equal(key.titles.length, 1, "the stale bind painted nothing");
			assert.equal(key.lastTitle, "21.4°C\nNew");
			assert.equal(source.listeners.size, 1, "exactly one live subscription");
		});

		it("cleans up on disappear: unsubscribes, forgets settings, stops late paints", async () => {
			const source = new FakeSource(makeSnapshot());
			const { controller } = setup(source);
			const key = new RecordingKeySurface("gone");
			await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
			assert.equal(source.listeners.size, 1);
			controller.disappear("gone");
			assert.equal(source.listeners.size, 0);
			assert.equal(controller.size, 0);
			assert.equal(getRememberedActionSettings("gone"), undefined);
			const titles = key.titles.length;
			source.emit({ snapshot: makeSnapshot([baseModule({ values: { temperature: 5 } })]) });
			assert.equal(key.titles.length, titles);
		});

		it("bounds the number of tracked actions", async () => {
			const source = new FakeSource(makeSnapshot());
			const { controller, env } = setup(source);
			for (let i = 0; i < MAX_CONTROLLED_ACTIONS + 3; i++) {
				await controller.appear(new RecordingKeySurface(`k${i}`), { moduleKey: BASE_KEY }, "temperature");
			}
			assert.equal(controller.size, MAX_CONTROLLED_ACTIONS);
			assert.ok(env.logger.lines.some((l) => l.includes("too many actions")));
			controller.dispose();
			assert.equal(controller.size, 0);
			assert.equal(source.listeners.size, 0);
		});

		it("without any service it shows 'Offline' instead of throwing", async () => {
			const { controller } = setup(undefined);
			const key = new RecordingKeySurface();
			await controller.appear(key, {}, "temperature");
			assert.equal(key.lastTitle, "Offline");
		});

		it("a PI-chosen metric overrides the action's default", async () => {
			const source = new FakeSource(makeSnapshot());
			const { controller } = setup(source);
			const key = new RecordingKeySurface();
			await controller.appear(key, { moduleKey: BASE_KEY, metric: "co2" }, "temperature");
			assert.equal(key.lastTitle, "612 ppm\nLiving r…");
		});

		it("repaints on a global settings change (units)", async () => {
			const source = new FakeSource(makeSnapshot());
			let notify: () => void = () => {};
			const global = { unitSystem: "account" } as { unitSystem: "account" | "imperial" };
			const { controller } = setup(source, {
				getGlobal: () => global,
				onGlobalChange: (l: () => void) => {
					notify = l;
					return () => {};
				},
			});
			const key = new RecordingKeySurface();
			await controller.appear(key, { moduleKey: BASE_KEY }, "temperature");
			global.unitSystem = "imperial";
			notify();
			assert.equal(key.lastTitle, "70.6°F\nLiving r…");
		});
	});
});

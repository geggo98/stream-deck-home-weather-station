/** The global unit system ("account" | "metric" | "imperial") decides when a key's own unit is "auto". */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { KeyController } from "../src/actions/key-controller.ts";
import { buildDialFeedback } from "../src/render/dial-feedback.ts";
import { buildKeyView } from "../src/render/key-view.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { BASE_ID, FakeSource, makeEnv, makeSnapshot, NOW, RecordingKeySurface, STATION_ID } from "./actions-fixtures.ts";
import type { GlobalSettings, MeasurementSettings } from "../src/pi-protocol.ts";

const moduleKey = makeModuleKey(STATION_ID, BASE_ID);
const view = (settings: MeasurementSettings, global: GlobalSettings, snapshot = makeSnapshot()) =>
	buildKeyView({ metric: "temperature", settings: { moduleKey, ...settings }, global, hasSource: true, connection: { kind: "ok" }, snapshot, now: NOW }).title?.split("\n")[0];

describe("global unit system", () => {
	it("applies when the key's own unit is auto or unset", () => {
		// Without resolveUnits consulting `global`, these would all follow the account (metric).
		assert.equal(view({}, { unitSystem: "imperial" }), "70.6°F");
		assert.equal(view({ unitSystem: "auto" }, { unitSystem: "imperial" }), "70.6°F");
		assert.equal(view({ unitSystem: "auto" }, { unitSystem: "metric" }), "21.4°C");
	});

	it("'account' and unset follow the Netatmo account's preferences", () => {
		const imperialAccount = makeSnapshot(undefined, { unitSystem: "imperial", windUnit: "mph", pressureUnit: "inhg" });
		assert.equal(view({}, { unitSystem: "account" }, imperialAccount), "70.6°F");
		assert.equal(view({}, {}, imperialAccount), "70.6°F");
		assert.equal(view({}, { unitSystem: "account" }), "21.4°C");
	});

	it("loses against a key's own explicit choice", () => {
		assert.equal(view({ unitSystem: "metric" }, { unitSystem: "imperial" }), "21.4°C");
		assert.equal(view({ unitSystem: "imperial" }, { unitSystem: "metric" }), "70.6°F");
	});

	it("also drives the dial", () => {
		const dial = (unitSystem: GlobalSettings["unitSystem"]) =>
			buildDialFeedback({ metric: "temperature", settings: { moduleKey }, global: { unitSystem }, hasSource: true, connection: { kind: "ok" }, snapshot: makeSnapshot(), now: NOW, showMinMax: false }).value.value;
		assert.equal(dial("imperial"), "70.6°F");
		assert.equal(dial("metric"), "21.4°C");
	});

	it("repaints a visible key when the global setting changes", async () => {
		let global: GlobalSettings = {};
		let notify = (): void => {};
		const env = makeEnv(new FakeSource(makeSnapshot()), { getGlobal: () => global, onGlobalChange: (l) => ((notify = l), () => {}) });
		const controller = new KeyController(env);
		const key = new RecordingKeySurface();
		await controller.appear(key, { moduleKey }, "temperature");
		assert.match(key.lastTitle ?? "", /^21\.4°C/);
		global = { unitSystem: "imperial" };
		notify();
		assert.match(key.lastTitle ?? "", /^70\.6°F/);
		controller.dispose();
	});
});

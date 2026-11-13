/** getMetrics may carry `defaultValue`: the action's preset metric, only when the module offers it. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { KeyController } from "../src/actions/key-controller.ts";
import { getRememberedDefaultMetric } from "../src/actions/global-settings.ts";
import { createPiRouter } from "../src/actions/pi-router.ts";
import { PI_EVENTS } from "../src/pi-protocol.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { BASE_ID, FakeService, FakeSource, makeEnv, makeSnapshot, RecordingKeySurface, RecordingLogger, RAIN_ID, STATION_ID } from "./actions-fixtures.ts";

function router(service: FakeService, settings: { moduleKey: string }) {
	const sent: Array<Record<string, unknown>> = [];
	const r = createPiRouter({
		getService: () => service,
		reply: async (payload) => {
			sent.push({ ...payload });
		},
		openUrl: async () => {},
		getActionSettings: () => settings,
		getActionDefaultMetric: (id) => getRememberedDefaultMetric(id),
		getGlobal: () => ({}),
		updateGlobal: async () => {},
		logger: new RecordingLogger(),
	});
	return { r, sent };
}

describe("getMetrics defaultValue", () => {
	it("carries the preset of the action id once the action appeared, and forgets it on disappear", async () => {
		const controller = new KeyController(makeEnv(new FakeSource(makeSnapshot())));
		const key = new RecordingKeySurface("humidity-key");
		await controller.appear(key, { moduleKey: makeModuleKey(STATION_ID, BASE_ID) }, "humidity");
		const { r, sent } = router(new FakeService(makeSnapshot()), { moduleKey: makeModuleKey(STATION_ID, BASE_ID) });
		await r.handle("humidity-key", { event: PI_EVENTS.getMetrics });
		assert.equal(sent.at(-1)?.defaultValue, "humidity");
		assert.ok(Array.isArray(sent.at(-1)?.items), "still an items array");
		await r.handle("unknown-key", { event: PI_EVENTS.getMetrics });
		assert.equal("defaultValue" in (sent.at(-1) ?? {}), false, "no preset known: the field is absent");
		controller.disappear("humidity-key");
		await r.handle("humidity-key", { event: PI_EVENTS.getMetrics });
		assert.equal("defaultValue" in (sent.at(-1) ?? {}), false);
	});

	it("is left out when the chosen module does not offer the preset", async () => {
		const controller = new KeyController(makeEnv(new FakeSource(makeSnapshot())));
		await controller.appear(new RecordingKeySurface("co2-key"), {}, "co2");
		const { r, sent } = router(new FakeService(makeSnapshot()), { moduleKey: makeModuleKey(STATION_ID, RAIN_ID) });
		await r.handle("co2-key", { event: PI_EVENTS.getMetrics });
		assert.equal("defaultValue" in (sent.at(-1) ?? {}), false, "a rain gauge has no CO2");
		controller.dispose();
	});
});

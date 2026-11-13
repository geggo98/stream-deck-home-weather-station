import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildDialFeedback, DIAL_ITEM_KEYS, DIM_OPACITY, type DialViewInput } from "../src/render/dial-feedback.ts";
import { isSvgDataUri } from "../src/render/data-uri.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { baseModule, BASE_ID, makeSnapshot, MIN, NOW, STATION_ID } from "./actions-fixtures.ts";

function input(overrides: Partial<DialViewInput> = {}): DialViewInput {
	return {
		metric: "temperature",
		settings: { moduleKey: makeModuleKey(STATION_ID, BASE_ID) },
		global: {},
		hasSource: true,
		connection: { kind: "ok" },
		snapshot: makeSnapshot(),
		now: NOW,
		showMinMax: false,
		...overrides,
	};
}

describe("buildDialFeedback", () => {
	it("writes exactly the $B1 item keys, each with an explicit opacity", () => {
		const payload = buildDialFeedback(input());
		assert.deepEqual(Object.keys(payload).sort(), [...DIAL_ITEM_KEYS].sort());
		for (const key of DIAL_ITEM_KEYS) assert.equal(typeof payload[key].opacity, "number", key);
	});

	it("fresh data: full opacity, value with unit, bar mapped to the gauge range", () => {
		const p = buildDialFeedback(input());
		assert.equal(p.title.value, "Temperature");
		assert.equal(p.value.value, "21.4°C");
		assert.equal(p.indicator.value, 69);
		assert.equal(p.value.opacity, 1);
		assert.ok(isSvgDataUri(p.icon.value), "the icon is a data URI, never a raw svg");
	});

	it("stale data dims every item and adds the age to the title", () => {
		const p = buildDialFeedback(input({ snapshot: makeSnapshot([baseModule({ measuredAt: NOW - 50 * MIN })]) }));
		for (const key of DIAL_ITEM_KEYS) assert.equal(p[key].opacity, DIM_OPACITY, key);
		assert.equal(p.title.value, "Temperature · 50 min");
		assert.equal(p.value.value, "21.4°C");
	});

	it("status words replace the value and zero the bar; opacity is stated explicitly", () => {
		const p = buildDialFeedback(input({ snapshot: undefined, connection: { kind: "no-credentials" } }));
		assert.equal(p.value.value, "Set up");
		assert.equal(p.indicator.value, 0);
		assert.equal(p.value.opacity, DIM_OPACITY);
		const back = buildDialFeedback(input());
		assert.equal(back.value.opacity, 1, "returning to normal says so out loud");
	});

	it("touch toggles min/max for temperature only", () => {
		assert.equal(buildDialFeedback(input({ showMinMax: true })).value.value, "↓19.2°C ↑22.8°C");
		assert.equal(buildDialFeedback(input({ showMinMax: true, metric: "humidity" })).value.value, "45%");
	});

	it("appends a trend arrow when asked", () => {
		const p = buildDialFeedback(input({ settings: { moduleKey: makeModuleKey(STATION_ID, BASE_ID), showTrend: true } }));
		assert.equal(p.value.value, "21.4°C ↑");
	});

	it("keeps untrusted labels out of control characters", () => {
		const p = buildDialFeedback(input({ settings: { moduleKey: makeModuleKey(STATION_ID, BASE_ID), label: "A\u0007B" } }));
		assert.equal(p.title.value, "A B");
	});

	it("only uses opacities with one decimal", () => {
		for (const o of [DIM_OPACITY, 1]) assert.equal(Math.round(o * 10) / 10, o);
	});
});

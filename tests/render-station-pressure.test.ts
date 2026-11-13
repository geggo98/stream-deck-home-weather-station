/**
 * "Station pressure" (the API's `AbsolutePressure` field) is a real, selectable display metric.
 * The live probe of 2026-11-13 (one elevated station, docs/WEATHER-API.md) showed that
 * `AbsolutePressure` is the station-level and `Pressure` the sea-level pressure; the labels
 * say exactly that much and the station-level value gets no sea-level colour bands.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { metricItems } from "../src/actions/pi-router.ts";
import { accentFor, NEUTRAL_COLOUR, pressureColour, STATION_PRESSURE_COLOUR } from "../src/render/colour.ts";
import { buildDialFeedback } from "../src/render/dial-feedback.ts";
import { buildKeyView } from "../src/render/key-view.ts";
import { DIAL_METRIC_ORDER, DISPLAY_METRIC_IDS, isDisplayMetricId, METRICS, metricsReportedBy } from "../src/render/metrics.ts";
import { baseModule, BASE_ID, makeSnapshot, NOW, STATION_ID } from "./actions-fixtures.ts";
import { makeModuleKey } from "../src/render/select.ts";

const snapshot = makeSnapshot();
const moduleKey = makeModuleKey(STATION_ID, BASE_ID);
const input = (extra = {}) => ({
	metric: "absolutePressure" as const,
	settings: { moduleKey },
	global: {},
	hasSource: true,
	connection: { kind: "ok" as const },
	snapshot,
	now: NOW,
	...extra,
});

describe("absolutePressure display metric", () => {
	it("is registered, selectable and reported by a module that has the field", () => {
		assert.ok(isDisplayMetricId("absolutePressure"));
		assert.ok(DISPLAY_METRIC_IDS.includes("absolutePressure"));
		assert.ok(DIAL_METRIC_ORDER.includes("absolutePressure"), "the dial must be able to reach it");
		assert.deepEqual(new Set(DIAL_METRIC_ORDER), new Set(DISPLAY_METRIC_IDS), "every metric is in the dial order");
		assert.ok(metricsReportedBy(baseModule().values).includes("absolutePressure"));
		assert.ok(!metricsReportedBy({ pressure: 1010 }).includes("absolutePressure"));
		assert.ok(metricItems(snapshot, { moduleKey }).some((i) => i.value === "absolutePressure" && i.label === "Station pressure"));
	});

	it("is labelled as the station-level pressure, the other one plainly as Pressure", () => {
		assert.equal(METRICS.absolutePressure.label, "Station pressure");
		assert.equal(METRICS.pressure.label, "Pressure", "the sea-level value keeps the label weather reports use");
		// "absolute" is API jargon and "alt." was the placeholder of the unverified mapping
		assert.doesNotMatch(METRICS.absolutePressure.label + METRICS.pressure.label, /absolute|alt\./i);
		for (const def of Object.values(METRICS)) assert.doesNotMatch(def.label, /\(alt\.\)/, `${def.id} still carries the old label`);
	});

	it("shows its own value, not the other pressure", () => {
		const view = buildKeyView(input());
		assert.equal(view.classification.kind, "value");
		assert.match(view.title ?? "", /^1000 hPa/, "fixture: pressure 1013.2, absolutePressure 1000.4");
		assert.match(buildKeyView(input({ metric: "pressure" })).title ?? "", /^1013 hPa/);
	});

	it("follows the pressure unit like the other pressure", () => {
		const imperial = { ...snapshot, preferences: { unitSystem: "imperial" as const, windUnit: "mph" as const, pressureUnit: "inhg" as const } };
		assert.match(buildKeyView(input({ snapshot: imperial })).title ?? "", /^29\.54 inHg/);
		const mmhg = { ...snapshot, preferences: { ...snapshot.preferences, pressureUnit: "mmhg" as const } };
		assert.match(buildKeyView(input({ snapshot: mmhg })).title ?? "", /^750 mmHg/);
	});

	it("has no value-dependent colour, while the other pressure keeps its bands", () => {
		assert.equal(accentFor("absolutePressure", 900), STATION_PRESSURE_COLOUR);
		assert.equal(accentFor("absolutePressure", 1040), STATION_PRESSURE_COLOUR);
		assert.equal(accentFor("absolutePressure", Number.NaN), NEUTRAL_COLOUR);
		assert.notEqual(pressureColour(990), pressureColour(1030));
	});

	it("never draws a trend, even when asked", () => {
		const view = buildKeyView(input({ settings: { moduleKey, showTrend: true } }));
		const plain = buildKeyView(input());
		assert.equal(view.svg, plain.svg);
		assert.equal(METRICS.absolutePressure.trend, undefined);
	});

	it("has a gauge range that fits an elevated station", () => {
		// 850 hPa is roughly 1500 m above sea level; below the range the bar is clamped, not broken.
		assert.ok(METRICS.absolutePressure.gauge.min <= 850);
		const dial = buildDialFeedback({ ...input(), showMinMax: false });
		assert.equal(dial.title.value, "Station pressure");
		assert.ok(dial.indicator.value > 0 && dial.indicator.value < 100);
	});
});

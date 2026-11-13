import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { beaufort, compassPoint, formatMetric, joinValueUnit, resolveUnits } from "../src/render/format.ts";
import { gaugePercent, METRICS, metricsReportedBy } from "../src/render/metrics.ts";
import { METRIC_PREFS } from "./actions-fixtures.ts";

const metric = resolveUnits(undefined, undefined, METRIC_PREFS);
const imperial = resolveUnits("imperial", undefined, METRIC_PREFS);

describe("resolveUnits", () => {
	it("follows the account when nothing is chosen", () => {
		const prefs = { unitSystem: "imperial", windUnit: "knots", pressureUnit: "mmhg", locale: "en-US" } as const;
		assert.deepEqual(resolveUnits("auto", "account", prefs), {
			temperature: "f",
			pressure: "mmhg",
			wind: "knots",
			rain: "in",
			locale: "en-US",
		});
	});

	it("lets the action beat the plugin-wide setting, and that beat the account", () => {
		assert.equal(resolveUnits("metric", "imperial", { ...METRIC_PREFS, unitSystem: "imperial" }).temperature, "c");
		assert.equal(resolveUnits("auto", "imperial", METRIC_PREFS).temperature, "f");
		assert.equal(resolveUnits(undefined, undefined, { ...METRIC_PREFS, unitSystem: "imperial" }).temperature, "f");
	});
});

describe("formatMetric", () => {
	it("rounds temperature to one decimal and keeps the unit tight", () => {
		const f = formatMetric(METRICS.temperature, 21.43, metric);
		assert.deepEqual([f.text, f.unit, f.tight, f.rounded], ["21.4", "°C", true, 21.4]);
		assert.equal(joinValueUnit(f), "21.4°C");
	});

	it("never shows a negative zero", () => {
		assert.equal(formatMetric(METRICS.temperature, -0.04, metric).text, "0.0");
		assert.equal(formatMetric(METRICS.temperature, -0.04, metric).rounded, 0);
	});

	it("converts to Fahrenheit, inHg, mph and inches", () => {
		assert.equal(formatMetric(METRICS.temperature, 20, imperial).text, "68.0");
		assert.equal(formatMetric(METRICS.pressure, 1013.25, imperial).text, "29.92");
		assert.equal(formatMetric(METRICS.wind, 100, imperial).text, "62");
		assert.equal(formatMetric(METRICS.rain24h, 25.4, imperial).text, "1.00");
	});

	it("supports m/s, knots, mmHg and Beaufort", () => {
		const prefs = (wind: "ms" | "knots" | "beaufort") => resolveUnits(undefined, undefined, { ...METRIC_PREFS, windUnit: wind, pressureUnit: "mmhg" });
		assert.equal(formatMetric(METRICS.wind, 36, prefs("ms")).text, "10.0");
		assert.equal(formatMetric(METRICS.wind, 100, prefs("knots")).text, "54");
		assert.equal(formatMetric(METRICS.wind, 30, prefs("beaufort")).text, "5");
		assert.equal(formatMetric(METRICS.wind, 30, prefs("beaufort")).unit, "Bft");
		assert.equal(formatMetric(METRICS.pressure, 1013.25, prefs("ms")).text, "760");
	});

	it("uses a decimal comma for a German locale and survives a junk locale", () => {
		const de = resolveUnits(undefined, undefined, { ...METRIC_PREFS, locale: "de-DE" });
		assert.equal(formatMetric(METRICS.temperature, 21.43, de).text, "21,4");
		const junk = resolveUnits(undefined, undefined, { ...METRIC_PREFS, locale: "not a locale!!" });
		assert.equal(formatMetric(METRICS.temperature, 21.43, junk).text, "21.4");
	});

	it("keeps ppm, dB and % unit placement", () => {
		assert.equal(joinValueUnit(formatMetric(METRICS.co2, 612, metric)), "612 ppm");
		assert.equal(joinValueUnit(formatMetric(METRICS.humidity, 45, metric)), "45%");
		assert.equal(joinValueUnit(formatMetric(METRICS.noise, 38, metric)), "38 dB");
	});
});

describe("beaufort and compass", () => {
	it("matches the standard km/h boundaries", () => {
		const cases: Array<[number, number]> = [[0, 0], [0.9, 0], [1, 1], [5.9, 1], [6, 2], [19.9, 3], [20, 4], [61.9, 7], [62, 8], [117.9, 11], [118, 12], [300, 12]];
		for (const [kmh, force] of cases) assert.equal(beaufort(kmh), force, `${kmh} km/h`);
	});

	it("names eight compass points and wraps", () => {
		assert.equal(compassPoint(0), "N");
		assert.equal(compassPoint(44), "NE");
		assert.equal(compassPoint(200), "S");
		assert.equal(compassPoint(359), "N");
		assert.equal(compassPoint(-90), "W");
		assert.equal(compassPoint(Number.NaN), undefined);
	});
});

describe("metrics", () => {
	it("maps a value into 0..100 and clamps", () => {
		assert.equal(gaugePercent(METRICS.humidity, 45), 45);
		assert.equal(gaugePercent(METRICS.temperature, -50), 0);
		assert.equal(gaugePercent(METRICS.temperature, 90), 100);
		assert.equal(gaugePercent(METRICS.temperature, Number.NaN), 0);
		assert.equal(gaugePercent(METRICS.temperature, 10), 50);
	});

	it("lists only what a module reports, in dial order", () => {
		assert.deepEqual(metricsReportedBy({ humidity: 50, temperature: 20 }), ["temperature", "humidity"]);
		assert.deepEqual(metricsReportedBy({ rain24h: 1, rain1h: 0 }), ["rain24h", "rain1h"]);
		assert.deepEqual(metricsReportedBy({ temperature: Number.NaN }), []);
	});
});

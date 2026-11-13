import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	accentFor,
	CO2_BANDS,
	co2Colour,
	humidityColour,
	isHexColour,
	mixColour,
	NEUTRAL_COLOUR,
	noiseColour,
	pressureColour,
	rainColour,
	safeColour,
	scaleColour,
	TEMPERATURE_STOPS,
	temperatureColour,
	windColour,
} from "../src/render/colour.ts";
import { DISPLAY_METRIC_IDS } from "../src/render/metrics.ts";

describe("colour helpers", () => {
	it("accepts exactly #rrggbb", () => {
		assert.equal(isHexColour("#00ff7A"), true);
		for (const bad of ["#fff", "00ff7a", "#00ff7aff", "red", "#00ff7g", "", undefined, 7, "#00ff7a\"/>"]) {
			assert.equal(isHexColour(bad), false, String(bad));
		}
	});

	it("falls back to neutral rather than letting a bad colour reach markup", () => {
		assert.equal(safeColour('"><script>'), NEUTRAL_COLOUR);
		assert.equal(safeColour("#112233"), "#112233");
	});

	it("mixes and scales", () => {
		assert.equal(mixColour("#000000", "#ffffff", 0.5), "#808080");
		assert.equal(mixColour("#102030", "#ffffff", 0), "#102030");
		assert.equal(scaleColour("#808080", 0.5), "#404040");
		assert.equal(scaleColour("#ffffff", 1), "#ffffff");
	});
});

describe("temperature gradient", () => {
	it("returns the stop colour at each stop", () => {
		for (const [celsius, colour] of TEMPERATURE_STOPS) assert.equal(temperatureColour(celsius).toLowerCase(), colour.toLowerCase(), `${celsius}`);
	});

	it("clamps outside the range and survives non-finite input", () => {
		assert.equal(temperatureColour(-80), TEMPERATURE_STOPS[0]![1]);
		assert.equal(temperatureColour(80), TEMPERATURE_STOPS.at(-1)![1]);
		assert.equal(temperatureColour(Number.NaN), NEUTRAL_COLOUR);
	});

	it("is quantised to whole degrees, so 0.1 jitter never changes the colour", () => {
		assert.equal(temperatureColour(21.4), temperatureColour(21.0));
		assert.equal(temperatureColour(21.6), temperatureColour(22.0));
	});

	it("always yields a valid colour", () => {
		for (let t = -40; t <= 60; t += 0.7) assert.ok(isHexColour(temperatureColour(t)), `${t}`);
	});
});

describe("bands", () => {
	it("CO2 bands change exactly at the named thresholds", () => {
		const [good, fair, poor] = CO2_BANDS;
		assert.notEqual(co2Colour(good), co2Colour(good + 1));
		assert.notEqual(co2Colour(fair), co2Colour(fair + 1));
		assert.notEqual(co2Colour(poor), co2Colour(poor + 1));
		assert.equal(co2Colour(400), co2Colour(good));
	});

	it("humidity is distinct for dry, comfortable and wet", () => {
		const set = new Set([humidityColour(20), humidityColour(45), humidityColour(65), humidityColour(90)]);
		assert.equal(set.size, 4);
	});

	it("noise, pressure, rain and wind are monotone in distinctness at their extremes", () => {
		assert.notEqual(noiseColour(30), noiseColour(95));
		assert.notEqual(pressureColour(980), pressureColour(1030));
		assert.notEqual(rainColour(0), rainColour(10));
		assert.notEqual(windColour(5), windColour(80));
	});

	it("every metric yields a valid colour for a normal and a non-finite value", () => {
		for (const id of DISPLAY_METRIC_IDS) {
			assert.ok(isHexColour(accentFor(id, 10)), id);
			assert.equal(accentFor(id, Number.NaN), NEUTRAL_COLOUR, id);
		}
	});
});

/** Pure navigation over the focus, with the two-station fixture. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nextMetric, nextModule, nextStation, parseFocus, resolveFocus, sameFocus, type Focus } from "../src/focus/navigate.ts";
import {
	baseModule,
	BASE_B_ID,
	MIN,
	NOW,
	BASE_ID,
	makeSnapshot,
	makeTwoStationSnapshot,
	OUTDOOR_B_ID,
	OUTDOOR_ID,
	RAIN_ID,
	STATION_B_ID,
	STATION_ID,
	WIND_ID,
} from "./actions-fixtures.ts";

const two = makeTwoStationSnapshot();
const atBase: Focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" };

describe("resolveFocus", () => {
	it("keeps a valid focus", () => {
		assert.deepEqual(resolveFocus(two, atBase), atBase);
	});

	it("falls back to the first station's base temperature for nothing, junk and a vanished module", () => {
		for (const stored of [undefined, null, 42, "x", {}, { stationId: STATION_ID }, { stationId: STATION_ID, moduleId: "gone", metric: "temperature" }]) {
			assert.deepEqual(resolveFocus(two, stored), atBase, JSON.stringify(stored));
		}
	});

	it("rejects metrics that are no display metric and over-long ids (settings are untrusted)", () => {
		assert.equal(parseFocus({ stationId: STATION_ID, moduleId: BASE_ID, metric: "tempMin" }), undefined);
		assert.equal(parseFocus({ stationId: "x".repeat(65), moduleId: BASE_ID, metric: "temperature" }), undefined);
		assert.equal(parseFocus({ stationId: STATION_ID, moduleId: BASE_ID, metric: "__proto__" }), undefined);
	});

	it("replaces a metric the module stopped reporting by its first one", () => {
		const stale = { stationId: STATION_ID, moduleId: WIND_ID, metric: "temperature" };
		assert.deepEqual(resolveFocus(two, stale), { stationId: STATION_ID, moduleId: WIND_ID, metric: "windStrength" });
	});

	it("never throws and gives undefined without data", () => {
		assert.equal(resolveFocus(undefined, atBase), undefined);
		assert.equal(resolveFocus({ ...two, stations: [] }, atBase), undefined);
		assert.equal(resolveFocus({ ...two, stations: [{ id: "s", name: "S", modules: [] }] }, atBase), undefined);
	});
});

describe("nextMetric", () => {
	it("walks through what THIS module reports and wraps in both directions", () => {
		let focus = atBase;
		const seen: string[] = [];
		for (let i = 0; i < 7; i++) {
			focus = nextMetric(two, focus, 1)!.focus;
			seen.push(focus.metric);
		}
		assert.deepEqual(seen, ["humidity", "co2", "noise", "pressure", "absolutePressure", "temperature", "humidity"]);
		assert.equal(nextMetric(two, atBase, -1)!.focus.metric, "absolutePressure");
	});

	it("is blocked for a module with one metric and leaves the focus alone", () => {
		const only = makeSnapshot([baseModule({ values: { temperature: 20 } })]);
		const result = nextMetric(only, atBase, 1)!;
		assert.equal(result.blocked, true);
		assert.deepEqual(result.focus, atBase);
	});

	it("starts from an end when the stored metric is not reported", () => {
		const stale = { stationId: STATION_ID, moduleId: RAIN_ID, metric: "co2" };
		assert.equal(nextMetric(two, stale, 1)!.focus.metric, "rain24h");
		assert.equal(nextMetric(two, stale, -1)!.focus.metric, "rain");
	});
});

describe("nextModule", () => {
	it("skips modules that lack the metric and wraps", () => {
		// temperature: base -> outdoor (wind and rain do not report it) -> base
		const first = nextModule(two, atBase, 1)!;
		assert.deepEqual(first, { focus: { ...atBase, moduleId: OUTDOOR_ID }, blocked: false });
		assert.equal(nextModule(two, first.focus, 1)!.focus.moduleId, BASE_ID);
		assert.equal(nextModule(two, atBase, -1)!.focus.moduleId, OUTDOOR_ID);
	});

	it("stays inside the station", () => {
		const second = nextModule(two, { stationId: STATION_B_ID, moduleId: BASE_B_ID, metric: "temperature" }, 1)!;
		assert.equal(second.focus.stationId, STATION_B_ID);
		assert.equal(second.focus.moduleId, OUTDOOR_B_ID);
	});

	it("is blocked when no other module reports the metric", () => {
		const co2 = { ...atBase, metric: "co2" as const };
		const result = nextModule(two, co2, 1)!;
		assert.equal(result.blocked, true);
		assert.equal(sameFocus(result.focus, co2), true);
	});

	it("repairs a vanished module first (a stale stored focus)", () => {
		const result = nextModule(two, { stationId: STATION_ID, moduleId: "gone", metric: "temperature" }, 1)!;
		assert.equal(result.focus.moduleId, OUTDOOR_ID, "resolved to the base, then one step on");
	});
});

describe("nextStation", () => {
	it("lands on the next station's base module, keeping the metric when it reports it", () => {
		const result = nextStation(two, { ...atBase, metric: "humidity" }, 1)!;
		assert.deepEqual(result, { focus: { stationId: STATION_B_ID, moduleId: BASE_B_ID, metric: "humidity" }, blocked: false });
	});

	it("takes the base module's first metric when it lacks the focused one, and wraps back", () => {
		const co2 = nextStation(two, { ...atBase, metric: "co2" }, 1)!;
		assert.equal(co2.focus.metric, "temperature", "station B's base has no CO2");
		assert.equal(nextStation(two, co2.focus, 1)!.focus.stationId, STATION_ID);
		assert.equal(nextStation(two, atBase, -1)!.focus.stationId, STATION_B_ID);
	});

	it("is blocked with one station", () => {
		const result = nextStation(makeSnapshot(), atBase, 1)!;
		assert.equal(result.blocked, true);
		assert.deepEqual(result.focus, atBase);
	});
});

describe("the previous direction", () => {
	// Three temperature modules in one station (base, outdoor, extra indoor), then three stations:
	// with two of anything, "+1" and "-1" land on the same entry and cannot be told apart.
	const extraIndoor = { ...baseModule(), id: "00:00:5e:00:53:05", role: "indoor-extra" as const, name: "Bedroom", measuredAt: NOW - 2 * MIN, values: { temperature: 19.5, humidity: 50 } };
	const threeModules = makeSnapshot([baseModule(), { ...baseModule(), id: OUTDOOR_ID, role: "outdoor" as const, name: "Garden", values: { temperature: 8, humidity: 80 } }, extraIndoor]);
	const third = { id: "00:00:5e:00:53:21", name: "Third Station", modules: [baseModule({ id: "00:00:5e:00:53:21", name: "Cellar", values: { temperature: 12, humidity: 60 } })] };
	const threeStations = { ...makeTwoStationSnapshot(), stations: [...makeTwoStationSnapshot().stations, third] };

	it("nextModule: next and previous differ, and previous wraps from the first module to the last", () => {
		const atOutdoor: Focus = { stationId: STATION_ID, moduleId: OUTDOOR_ID, metric: "temperature" };
		assert.equal(nextModule(threeModules, atOutdoor, 1)?.focus.moduleId, extraIndoor.id);
		assert.equal(nextModule(threeModules, atOutdoor, -1)?.focus.moduleId, BASE_ID);
		assert.equal(nextModule(threeModules, atBase, -1)?.focus.moduleId, extraIndoor.id, "wraps backwards");
		assert.equal(nextModule(threeModules, atBase, 1)?.focus.moduleId, OUTDOOR_ID);
	});

	it("nextStation: next and previous differ with three stations, and both wrap", () => {
		const at = (stationId: string, moduleId: string): Focus => ({ stationId, moduleId, metric: "temperature" });
		assert.equal(nextStation(threeStations, atBase, 1)?.focus.stationId, STATION_B_ID);
		assert.equal(nextStation(threeStations, atBase, -1)?.focus.stationId, third.id, "previous from the first wraps to the last");
		assert.equal(nextStation(threeStations, at(STATION_B_ID, BASE_B_ID), -1)?.focus.stationId, STATION_ID);
		assert.equal(nextStation(threeStations, at(third.id, third.id), 1)?.focus.stationId, STATION_ID, "next from the last wraps to the first");
		assert.equal(nextStation(threeStations, at(third.id, third.id), -1)?.focus.stationId, STATION_B_ID);
	});

	it("nextMetric: previous from the first metric wraps to the last the module reports", () => {
		const list = ["temperature", "humidity", "co2", "noise", "pressure", "absolutePressure"] as const;
		assert.equal(nextMetric(two, atBase, -1)?.focus.metric, list.at(-1));
		assert.equal(nextMetric(two, atBase, 1)?.focus.metric, list[1]);
	});
});

describe("ids that contain the module key separator", () => {
	it("are not ids (a module key could not be told apart from two ids)", () => {
		assert.equal(parseFocus({ stationId: "a|b", moduleId: BASE_ID, metric: "temperature" }), undefined);
		assert.equal(parseFocus({ stationId: STATION_ID, moduleId: "a|b", metric: "temperature" }), undefined);
		assert.ok(parseFocus({ stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" }), "negative control");
	});
});

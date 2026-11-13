/** The display table of the history face. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { HistoryResult } from "../src/adapter/station/types.ts";
import { buildHistoryView, historyRequestFor, type HistoryViewInput } from "../src/render/history-view.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { baseModule, BASE_ID, decodeSvg, historyPoints, makeSnapshot, METRIC_PREFS, MIN, NOW, okHistory, RAIN_ID, STATION_ID } from "./actions-fixtures.ts";

const snapshot = makeSnapshot();
const request = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" as const, window: "24h" as const };

function input(extra: Partial<HistoryViewInput> = {}): HistoryViewInput {
	return {
		metric: "temperature",
		settings: { moduleKey: makeModuleKey(STATION_ID, BASE_ID) },
		global: {},
		hasSource: true,
		connection: { kind: "ok" },
		snapshot,
		now: NOW,
		window: "24h",
		result: okHistory(request),
		...extra,
	};
}

describe("buildHistoryView", () => {
	it("draws a curve with the window and the extremes in the title", () => {
		const view = buildHistoryView(input());
		assert.equal(view.chart, true);
		assert.equal(view.title, "24 h\n↓10.0 ↑33.0°C");
		assert.match(decodeSvg(`data:image/svg+xml;base64,${Buffer.from(view.svg).toString("base64")}`), /<path d="M/);
	});

	it("converts to the display unit", () => {
		const view = buildHistoryView(input({ settings: { moduleKey: makeModuleKey(STATION_ID, BASE_ID), unitSystem: "imperial" } }));
		assert.match(view.title ?? "", /°F$/);
	});

	it("the display table: loading, no history, errors", () => {
		assert.equal(buildHistoryView(input({ result: undefined })).title, "Loading");
		assert.equal(buildHistoryView(input({ metric: "absolutePressure" })).title, "No history");
		assert.equal(buildHistoryView(input({ result: okHistory(request, []) })).title, "No history");
		const error = (reason: "auth" | "rate" | "transient" | "unsupported"): HistoryResult => ({ kind: "error", request, message: "x", reason });
		assert.equal(buildHistoryView(input({ result: error("auth") })).title, "Sign in");
		assert.equal(buildHistoryView(input({ result: error("rate") })).title, "Try later");
		assert.equal(buildHistoryView(input({ result: error("transient") })).title, "Offline");
		assert.equal(buildHistoryView(input({ result: error("unsupported") })).title, "No history");
		for (const reason of ["auth", "rate", "transient", "unsupported"] as const) assert.equal(buildHistoryView(input({ result: error(reason) })).chart, false);
	});

	it("status beats history: signed out, unreachable, unknown module", () => {
		assert.equal(buildHistoryView(input({ connection: { kind: "auth-error", message: "x", since: NOW } })).title, "Sign in");
		assert.equal(buildHistoryView(input({ connection: { kind: "no-credentials" } })).title, "Set up");
		assert.equal(buildHistoryView(input({ hasSource: false })).title, "Offline");
		assert.equal(buildHistoryView(input({ snapshot: makeSnapshot([baseModule({ reachable: false, measuredAt: NOW - 300 * MIN })]) })).title, "No signal");
		assert.equal(buildHistoryView(input({ settings: { moduleKey: makeModuleKey(STATION_ID, "00:00:5e:00:53:99") } })).title, "Pick\nmodule");
	});

	it("draws rain as bars with the total in the title", () => {
		const rainRequest = { stationId: STATION_ID, moduleId: RAIN_ID, metric: "rain" as const, window: "24h" as const };
		const points = historyPoints(10, 60 * MIN, NOW, (i) => (i % 3 === 0 ? 0.5 : 0));
		const view = buildHistoryView(input({
			metric: "rain24h",
			settings: { moduleKey: makeModuleKey(STATION_ID, RAIN_ID) },
			result: { kind: "ok", request: rainRequest, points, stepMs: 60 * MIN, fetchedAt: NOW },
		}));
		assert.match(view.svg, /<rect x=/);
		assert.equal(view.title, "24 h\nΣ 2.0\u00a0mm");
	});

	it("an unchanged series gives the same image a minute later (the axis is quantised to the bucket)", () => {
		const a = buildHistoryView(input({ now: NOW + 1_000 }));
		const b = buildHistoryView(input({ now: NOW + 2_000 }));
		assert.equal(a.svg, b.svg);
	});

	it("never lets an API string into the markup", () => {
		const hostile = makeSnapshot([baseModule({ name: '"><script>alert(1)</script>' })]);
		const view = buildHistoryView(input({ snapshot: hostile }));
		assert.equal(/script|alert/.test(view.svg), false);
	});

	it("maps display metrics to history types; station pressure and gusts have none", () => {
		const selected = { station: { id: STATION_ID }, module: { id: BASE_ID } };
		assert.equal(historyRequestFor(selected, "rain1h", "6h")?.metric, "rain");
		assert.equal(historyRequestFor(selected, "wind", "3d")?.metric, "windStrength");
		assert.equal(historyRequestFor(selected, "absolutePressure", "24h"), undefined);
		assert.equal(historyRequestFor(selected, "gust", "24h"), undefined);
		assert.ok(METRIC_PREFS);
	});
});

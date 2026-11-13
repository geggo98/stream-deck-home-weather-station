/**
 * The display table of docs/ARCHITECTURE.md, as a test: what a key shows for every
 * combination of connection state and data age. buildKeyView is pure, so this needs no SDK.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ConnectionState } from "../src/adapter/station/types.ts";
import type { MeasurementSettings } from "../src/pi-protocol.ts";
import type { DisplayMetricId } from "../src/render/metrics.ts";
import { buildKeyView, type KeyViewInput } from "../src/render/key-view.ts";
import { classify, formatAge, moduleFreshness, STALE_AFTER_MS } from "../src/render/status.ts";
import { adoptionCandidate, findModule, makeModuleKey, parseModuleKey } from "../src/render/select.ts";
import { cleanLabel, joinLines, STATUS_WORDS } from "../src/render/title.ts";
import { GLYPHS } from "../src/render/generated/glyphs.ts";
import {
	baseModule,
	BASE_ID,
	makeSnapshot,
	METRIC_PREFS,
	MIN,
	NOW,
	OUTDOOR_ID,
	outdoorModule,
	rainModule,
	STATION_ID,
	windModule,
} from "./actions-fixtures.ts";

const BASE_KEY = makeModuleKey(STATION_ID, BASE_ID);
const OUTDOOR_KEY = makeModuleKey(STATION_ID, OUTDOOR_ID);

function view(
	overrides: Partial<KeyViewInput> & { settings?: MeasurementSettings; metric?: DisplayMetricId } = {},
	connection: ConnectionState = { kind: "ok" },
) {
	return buildKeyView({
		metric: "temperature",
		settings: { moduleKey: BASE_KEY },
		global: {},
		hasSource: true,
		connection,
		snapshot: makeSnapshot(),
		now: NOW,
		...overrides,
	});
}

describe("display table", () => {
	it("fresh: value and label, normal colours, no status dot", () => {
		const v = view();
		assert.equal(v.title, "21.4°C\nLiving room");
		assert.equal(v.classification.kind, "value");
		assert.equal(v.svg.includes("<circle"), false);
	});

	it("stale: value stays, age hint replaces the label, dimmed, with a status dot", () => {
		const snapshot = makeSnapshot([baseModule({ measuredAt: NOW - 40 * MIN })]);
		const v = view({ snapshot });
		assert.equal(v.title, "21.4°C\n40 min");
		assert.ok(v.svg.includes("<circle"));
		assert.notEqual(v.svg, view().svg);
	});

	it("unreachable module: dimmed icon and 'No signal'", () => {
		const snapshot = makeSnapshot([baseModule({ reachable: false, measuredAt: NOW - 3 * 60 * MIN })]);
		const v = view({ snapshot });
		assert.equal(v.title, "No signal");
		assert.equal(v.classification.kind, "unreachable");
	});

	it("transient error with cached data: as stale", () => {
		const v = view({}, { kind: "error", message: "timeout", since: NOW - MIN, retryAt: NOW + MIN });
		assert.equal(v.classification.kind, "value");
		assert.ok(v.title?.includes("min"), v.title);
		assert.ok(v.svg.includes("<circle"));
	});

	it("transient error without any data: 'Offline'", () => {
		const v = view({ snapshot: undefined }, { kind: "error", message: "timeout", since: NOW, retryAt: NOW + MIN });
		assert.equal(v.title, "Offline");
	});

	it("auth-error: warning icon and 'Sign in', even with cached data", () => {
		const v = view({}, { kind: "auth-error", message: "revoked", since: NOW });
		assert.equal(v.title, "Sign in");
		assert.ok(v.svg.includes(GLYPHS["triangle-alert"]));
	});

	it("no-credentials: setup icon and 'Set up'", () => {
		const v = view({ snapshot: undefined }, { kind: "no-credentials" });
		assert.equal(v.title, "Set up");
		assert.ok(v.svg.includes(GLYPHS.settings));
	});

	it("loading: neutral icon and an ellipsis", () => {
		const v = view({ snapshot: undefined }, { kind: "loading" });
		assert.equal(v.title, "…");
		assert.ok(v.svg.includes(GLYPHS.loader));
	});

	it("no service at all: 'Offline'", () => {
		assert.equal(view({ hasSource: false, snapshot: undefined }).title, "Offline");
	});

	it("module gone from the account: 'Pick module'; metric not reported: 'No data'", () => {
		assert.equal(view({ settings: { moduleKey: makeModuleKey(STATION_ID, "00:00:5e:00:53:99") } }).title, "Pick module");
		assert.equal(view({ settings: { moduleKey: OUTDOOR_KEY }, metric: "co2" }).title, "No data");
	});

	it("an explicitly cleared module stays empty instead of adopting", () => {
		assert.equal(view({ settings: { moduleKey: "" } }).title, "Pick module");
	});

	it("every status word in the table is what the table says", () => {
		assert.equal(STATUS_WORDS["unreachable"], "No signal");
		assert.equal(STATUS_WORDS["auth-error"], "Sign in");
		assert.equal(STATUS_WORDS["no-credentials"], "Set up");
		assert.equal(STATUS_WORDS["loading"], "…");
	});

	it("status beats metadata: the min/max overlay cannot outlive an outage", () => {
		const v = view({ overlay: true }, { kind: "auth-error", message: "x", since: NOW });
		assert.equal(v.title, "Sign in");
		const unreachable = view({ overlay: true, snapshot: makeSnapshot([baseModule({ reachable: false, measuredAt: NOW - 90 * MIN })]) });
		assert.equal(unreachable.title, "No signal");
	});
});

describe("value rendering", () => {
	it("shows today's min and max as an overlay for temperature", () => {
		assert.equal(view({ overlay: true }).title, "\u219122.8\u00b0C\n\u219319.2\u00b0C");
	});

	it("ignores the overlay for a metric without extremes", () => {
		assert.equal(view({ overlay: true, metric: "humidity" }).title, "45%\nLiving room");
	});

	it("adds a min/max line and hint only on request", () => {
		assert.equal(view({ settings: { moduleKey: BASE_KEY, showMinMax: true } }).title, "21.4°C\nLiving room\n↓19 ↑23");
		assert.ok(view({ settings: { moduleKey: BASE_KEY, showMinMax: true } }).svg.includes(GLYPHS["arrow-up-to-line"]));
		assert.equal(view().svg.includes(GLYPHS["arrow-up-to-line"]), false);
	});

	it("draws the trend arrow only when asked and when the API reports one", () => {
		assert.ok(view({ settings: { moduleKey: BASE_KEY, showTrend: true } }).svg.includes(GLYPHS["arrow-up"]));
		assert.ok(view({ settings: { moduleKey: OUTDOOR_KEY, showTrend: true } }).svg.includes(GLYPHS["arrow-down"]));
		assert.equal(view().svg.includes(GLYPHS["arrow-up"]), false);
		assert.ok(view({ metric: "pressure", settings: { moduleKey: BASE_KEY, showTrend: true } }).svg.includes(GLYPHS["arrow-right"]));
	});

	it("bigText moves the value into the image and leaves the title to the label", () => {
		const v = view({ settings: { moduleKey: BASE_KEY, bigText: true } });
		assert.ok(v.svg.includes("21.4"));
		assert.equal(v.title, "Living room");
	});

	it("a user label beats the module name; wind shows its compass point", () => {
		assert.equal(view({ settings: { moduleKey: BASE_KEY, label: "Lounge" } }).title, "21.4°C\nLounge");
		const wind = makeSnapshot([baseModule(), windModule()]);
		const v = view({ metric: "wind", snapshot: wind, settings: { moduleKey: makeModuleKey(STATION_ID, windModule().id) } });
		assert.equal(v.title, "18 km/h\nS");
	});

	it("honours imperial units", () => {
		assert.equal(view({ settings: { moduleKey: BASE_KEY, unitSystem: "imperial" } }).title, "70.6°F\nLiving room");
	});

	it("never puts API strings into the SVG", () => {
		const evil = '"><script>alert(1)</script>';
		const snapshot = makeSnapshot([baseModule({ name: evil })]);
		const v = view({ snapshot, settings: { moduleKey: BASE_KEY, bigText: true, label: evil } });
		assert.equal(v.svg.includes("script"), false);
		assert.equal(v.svg.includes("alert"), false);
	});

	it("is quantised: a poll with a jittering decimal does not change the image", () => {
		const a = view({ snapshot: makeSnapshot([baseModule({ values: { temperature: 21.41 } })]) });
		const b = view({ snapshot: makeSnapshot([baseModule({ values: { temperature: 21.44 } })]) });
		assert.equal(a.svg, b.svg);
		assert.equal(a.title, b.title);
	});

	it("rain defaults to the 24 h total", () => {
		const snapshot = makeSnapshot([baseModule(), rainModule()]);
		const v = view({ metric: "rain24h", snapshot, settings: { moduleKey: makeModuleKey(STATION_ID, rainModule().id) } });
		assert.equal(v.title, "7.6 mm\nRain gauge");
	});
});

describe("freshness, selection and text helpers", () => {
	it("derives freshness from the clock, not from `reachable`", () => {
		assert.equal(moduleFreshness(baseModule({ measuredAt: NOW - STALE_AFTER_MS }), NOW), "fresh");
		assert.equal(moduleFreshness(baseModule({ measuredAt: NOW - STALE_AFTER_MS - 1 }), NOW), "stale");
		assert.equal(moduleFreshness(baseModule({ measuredAt: NOW - STALE_AFTER_MS - 1, reachable: false }), NOW), "unreachable");
		assert.equal(moduleFreshness(baseModule({ measuredAt: NOW - MIN, reachable: false }), NOW), "fresh");
		assert.equal(moduleFreshness(baseModule({ measuredAt: null }), NOW), "unknown");
		assert.equal(moduleFreshness(baseModule({ measuredAt: null, reachable: false }), NOW), "unreachable");
	});

	it("formats ages", () => {
		assert.equal(formatAge(30_000), "1 min");
		assert.equal(formatAge(40 * MIN), "40 min");
		assert.equal(formatAge(3 * 60 * MIN), "3 h");
		assert.equal(formatAge(72 * 60 * MIN), "3 d");
	});

	it("parses and builds module keys", () => {
		assert.deepEqual(parseModuleKey(BASE_KEY), { stationId: STATION_ID, moduleId: BASE_ID });
		for (const bad of [undefined, "", "|", "a|", "|b", "nobar"]) assert.equal(parseModuleKey(bad), undefined, String(bad));
	});

	it("adopts the base station when it reports the metric, else the first module that does", () => {
		const snapshot = makeSnapshot();
		assert.equal(adoptionCandidate(snapshot, "temperature")?.module.id, BASE_ID);
		assert.equal(adoptionCandidate(snapshot, "wind")?.module.role, "wind");
		assert.equal(adoptionCandidate(snapshot, "rain24h")?.module.role, "rain");
		assert.equal(adoptionCandidate(makeSnapshot([baseModule({ values: {} })]), "wind")?.module.id, BASE_ID);
		assert.equal(adoptionCandidate({ ...snapshot, stations: [] }, "temperature"), undefined);
		assert.equal(findModule(snapshot, OUTDOOR_KEY)?.module.name, "Garden");
		assert.equal(findModule(snapshot, "x|y"), undefined);
	});

	it("cleans untrusted labels", () => {
		assert.equal(cleanLabel("Gar\u0000den‮!"), "Gar den !");
		assert.equal(cleanLabel("a very long module name"), "a very long\u2026");
		assert.equal(cleanLabel(undefined), "");
		assert.equal(joinLines([undefined, "", "a", "b"]), "a\nb");
		assert.equal(joinLines([undefined, ""]), undefined);
	});

	it("classify reports no-service before anything else", () => {
		assert.equal(classify({ hasSource: false, connection: { kind: "ok" }, snapshot: makeSnapshot(), moduleKey: BASE_KEY, metric: "temperature", now: NOW }).kind, "no-service");
		assert.equal(METRIC_PREFS.unitSystem, "metric");
	});
});

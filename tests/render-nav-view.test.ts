/** Faces of the navigation and utility keys. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Focus } from "../src/focus/navigate.ts";
import { buildNavView, infoPages, type NavViewInput } from "../src/render/nav-view.ts";
import { BASE_ID, baseModule, makeSnapshot, makeTwoStationSnapshot, NOW, OUTDOOR_ID, STATION_ID } from "./actions-fixtures.ts";

const focus: Focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" };
const input = (extra: Partial<NavViewInput> & Pick<NavViewInput, "kind">): NavViewInput => ({
	hasSource: true,
	connection: { kind: "ok" },
	snapshot: makeTwoStationSnapshot(),
	focus,
	now: NOW,
	...extra,
});

describe("buildNavView", () => {
	it("every kind gives a 144x144 tile without markup from outside, for hostile names", () => {
		const hostile = makeSnapshot([baseModule({ name: '"><script>1</script>' }), { ...baseModule({ id: OUTDOOR_ID }), name: "<b>&", role: "outdoor", batteryPercent: 10 }]);
		for (const kind of ["refresh", "next-metric", "prev-metric", "next-sensor", "prev-sensor", "next-station", "prev-station", "auto-rotate", "info"] as const) {
			for (const snapshot of [hostile, makeTwoStationSnapshot(), undefined]) {
				const view = buildNavView(input({ kind, snapshot, infoPage: 1 }));
				assert.match(view.svg, /^<svg [^>]*width="144" height="144"/, kind);
				assert.equal(/<script|<b>|NaN|undefined/.test(view.svg), false, kind);
			}
		}
	});

	it("is blocked (dimmed) exactly when a press would change nothing", () => {
		assert.equal(buildNavView(input({ kind: "next-station" })).blocked, false);
		assert.equal(buildNavView(input({ kind: "next-station", snapshot: makeSnapshot() })).blocked, true);
		assert.equal(buildNavView(input({ kind: "next-sensor", focus: { ...focus, metric: "co2" } })).blocked, true);
		assert.equal(buildNavView(input({ kind: "next-metric" })).blocked, false);
		assert.notEqual(buildNavView(input({ kind: "next-station" })).svg, buildNavView(input({ kind: "next-station", snapshot: makeSnapshot() })).svg);
	});

	it("status beats navigation", () => {
		const signedOut = buildNavView(input({ kind: "next-metric", connection: { kind: "auth-error", message: "x", since: NOW } }));
		assert.equal(signedOut.title, "Sign in");
		assert.equal(buildNavView(input({ kind: "refresh", connection: { kind: "no-credentials" } })).title, "Set up");
		assert.equal(buildNavView(input({ kind: "refresh", snapshot: undefined, connection: { kind: "loading" } })).title, "…");
		assert.equal(buildNavView(input({ kind: "info", hasSource: false })).title, "Offline");
	});

	it("auto rotate shows its state and interval", () => {
		assert.equal(buildNavView(input({ kind: "auto-rotate" })).title, "Off");
		assert.equal(buildNavView(input({ kind: "auto-rotate", autoRotateOn: true, autoRotateSeconds: 12 })).title, "On\n12 s");
	});

	it("info: age first, battery only where reported, low battery looks different", () => {
		const outdoor = { ...focus, moduleId: OUTDOOR_ID };
		assert.deepEqual(infoPages(makeTwoStationSnapshot().stations[0]!.modules[1]), ["age", "battery"]);
		assert.deepEqual(infoPages(makeTwoStationSnapshot().stations[0]!.modules[0]), ["age"]);
		assert.equal(buildNavView(input({ kind: "info", focus: outdoor, infoPage: 0 })).title, "3 min\nGarden");
		const battery = buildNavView(input({ kind: "info", focus: outdoor, infoPage: 1 }));
		assert.equal(battery.title, "80 %\nGarden");
		const low = makeSnapshot([baseModule(), { ...makeTwoStationSnapshot().stations[0]!.modules[1]!, batteryPercent: 10 }]);
		assert.notEqual(buildNavView(input({ kind: "info", focus: outdoor, infoPage: 1, snapshot: low })).svg, battery.svg);
		assert.equal(buildNavView(input({ kind: "info", focus, infoPage: 1 })).title, "2 min\nLiving r…", "no battery page on the base station: stays on the age");
	});

	it("a stale reading dims the reload face and says how old it is", () => {
		const old = makeSnapshot([baseModule({ measuredAt: NOW - 2 * 3_600_000 })]);
		const view = buildNavView(input({ kind: "refresh", snapshot: old }));
		assert.equal(view.title, "2 h");
		assert.notEqual(view.svg, buildNavView(input({ kind: "refresh" })).svg);
	});
});

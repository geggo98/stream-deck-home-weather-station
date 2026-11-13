/** Per-key alert thresholds: a static alert face (colour + border), never blinking. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { KeyController } from "../src/actions/key-controller.ts";
import { alertOf } from "../src/focus/settings.ts";
import { buildKeyView, isAlerting } from "../src/render/key-view.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { BASE_ID, baseModule, decodeSvg, FakeSource, makeEnv, makeFocusStore, makeSnapshot, NOW, RecordingKeySurface, STATION_ID } from "./actions-fixtures.ts";

const moduleKey = makeModuleKey(STATION_ID, BASE_ID);
const view = (settings: object, metric: "temperature" | "co2" = "temperature", snapshot = makeSnapshot()) =>
	buildKeyView({ metric, settings: { moduleKey, ...settings }, global: {}, hasSource: true, connection: { kind: "ok" }, snapshot, now: NOW });

describe("alert thresholds", () => {
	it("reads numbers and numeric text from the Property Inspector, ignores junk", () => {
		assert.deepEqual(alertOf({ alertAbove: "25,5", alertBelow: 3 }), { above: 25.5, below: 3 });
		assert.deepEqual(alertOf({ alertAbove: "", alertBelow: "warm" }), { above: undefined, below: undefined });
		assert.deepEqual(alertOf(undefined), { above: undefined, below: undefined });
	});

	it("trips above and below, in display units, on the displayed (rounded) number", () => {
		assert.equal(isAlerting(21.4, { alertAbove: 21.4 }), false, "equal is not above");
		assert.equal(isAlerting(21.4, { alertAbove: 21 }), true);
		assert.equal(isAlerting(21.4, { alertBelow: 22 }), true);
		assert.equal(isAlerting(21.4, { alertBelow: 21.4, alertAbove: 21.4 }), false);
		assert.equal(isAlerting(21.4, {}), false);
	});

	it("changes the face: alert colour and a border, otherwise identical", () => {
		const calm = decodeSvgOf(view({}));
		const alerting = decodeSvgOf(view({ alertAbove: 20 }));
		assert.notEqual(calm, alerting);
		assert.match(alerting, /stroke="#E5534B" stroke-width="6"/);
		assert.doesNotMatch(calm, /stroke-width="6"/);
		assert.equal(decodeSvgOf(view({ alertAbove: 30 })), calm, "a threshold that is not crossed changes nothing");
	});

	it("compares in the key's unit system: 21.4 C is 70.5 F", () => {
		const f = (alertAbove: number) => decodeSvgOf(view({ unitSystem: "imperial", alertAbove }));
		assert.match(f(70), /stroke-width="6"/);
		assert.doesNotMatch(f(71), /stroke-width="6"/);
	});

	it("is static: the same state gives the same image every time (no blinking)", async () => {
		const source = new FakeSource(makeSnapshot());
		const controller = new KeyController(makeEnv(source));
		const key = new RecordingKeySurface();
		await controller.appear(key, { moduleKey, alertAbove: 20 }, "temperature");
		const n = key.images.length;
		for (let i = 0; i < 5; i++) source.emit();
		assert.equal(key.images.length, n, "repaints write nothing new");
	});

	it("never alerts on a status face (no value, no verdict)", () => {
		const gone = buildKeyView({ metric: "temperature", settings: { moduleKey, alertAbove: -100 }, global: {}, hasSource: true, connection: { kind: "auth-error", message: "x", since: NOW }, snapshot: makeSnapshot(), now: NOW });
		assert.doesNotMatch(gone.svg, /stroke-width="6"/);
		const nodata = view({ alertAbove: -100 }, "co2", makeSnapshot([baseModule({ values: { temperature: 20 } })]));
		assert.doesNotMatch(nodata.svg, /stroke-width="6"/);
	});

	it("re-binds when only a threshold changes", async () => {
		const controller = new KeyController(makeEnv(new FakeSource(makeSnapshot())));
		const key = new RecordingKeySurface();
		await controller.appear(key, { moduleKey }, "temperature");
		const before = key.lastImage;
		controller.settingsChanged(key.id, { moduleKey, alertBelow: "99" as never });
		await new Promise((r) => setTimeout(r, 30));
		assert.notEqual(key.lastImage, before);
		assert.match(decodeSvg(key.lastImage), /stroke-width="6"/);
	});
});

function decodeSvgOf(v: { svg: string }): string {
	return v.svg;
}

describe("alerts on a key that follows the focus", () => {
	const focusKey = { stationId: STATION_ID, moduleId: BASE_ID };

	it("are ignored, so a threshold typed for one unit cannot trip on another metric; they apply again when it stops following", async () => {
		const source = new FakeSource(makeSnapshot());
		const store = makeFocusStore({ ...focusKey, metric: "humidity" }).store;
		const controller = new KeyController(makeEnv(source, { focus: store }));
		const key = new RecordingKeySurface();
		// alertAbove=30 was meant for temperature; the focus shows humidity (45 %).
		await controller.appear(key, { moduleKey, alertAbove: 30 }, { metric: "temperature", follow: true });
		assert.doesNotMatch(decodeSvg(key.lastImage), /stroke-width="6"/);
		const fixed = new RecordingKeySurface("fixed");
		await controller.appear(fixed, { moduleKey, metric: "humidity", alertAbove: 30, followFocus: false }, "humidity");
		assert.match(decodeSvg(fixed.lastImage), /stroke-width="6"/, "a fixed-metric key still alerts");
	});
});

/** A key press asks for a refresh that is rate-limited to one request per minute; the wording must say so. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PLUGIN_DIR_NAME } from "../scripts/lib/plugin-id.ts";
import { DIAL_SPEC, DIAL_SPECS, SENSOR_DIAL_SPEC, VALUE_DIAL_SPEC, FOCUS_SPECS, KEYPAD_SPECS } from "../src/actions/catalog.ts";

const ROOT = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, PLUGIN_DIR_NAME, "manifest.json"), "utf-8")) as { Actions: Array<{ Tooltip: string; Encoder?: { TriggerDescription: { Push: string; Touch: string } } }> };

describe("press wording", () => {
	const specs = [...KEYPAD_SPECS, ...FOCUS_SPECS, ...DIAL_SPECS];

	it("every measurement key that refreshes on a press says it is at most once a minute", () => {
		for (const spec of [...KEYPAD_SPECS, FOCUS_SPECS.find((s) => s.id === "focus")!]) {
			assert.match(spec.tooltip, /Press to request fresh data \(at most once a minute\)/, spec.id);
			assert.doesNotMatch(spec.tooltip, /Press to refresh/, "a bare 'refresh' reads as a guaranteed new request");
		}
	});

	it("the reload key says exactly what it does and what it cannot do", () => {
		const reload = FOCUS_SPECS.find((s) => s.id === "focus-refresh")!.tooltip;
		assert.match(reload, /newest data the cloud has/);
		assert.match(reload, /at most one real request per minute/);
		assert.match(reload, /cannot make the station measure/);
		assert.match(reload, /about every 10 minutes/);
		assert.doesNotMatch(reload, /measure now|force/i);
	});

	it("every dial says tap = reload at most once a minute, and what the switch does", () => {
		for (const spec of DIAL_SPECS) {
			assert.match(spec.tooltip, /Tap the strip to request fresh data \(at most once a minute\)/, spec.id);
			assert.match(spec.trigger.Touch, /reload \(once a minute at most\)/, spec.id);
			assert.match(spec.tooltip, /The switch decides what a turn changes: the shared focus \(all following keys move too\) or only what this dial shows\./, spec.id);
		}
	});

	it("the three dials say what turn, turn while pressed and press do", () => {
		assert.match(SENSOR_DIAL_SPEC.tooltip, /^Turn for the next sensor, turn while pressed for the next station, press to request fresh data\./);
		assert.equal(SENSOR_DIAL_SPEC.trigger.Rotate, "Next sensor (pressed: next station)");
		assert.match(SENSOR_DIAL_SPEC.trigger.Push, /^Reload/);
		assert.match(VALUE_DIAL_SPEC.tooltip, /^Turn for the next value of the sensor, turn while pressed for the next sensor, press to request fresh data\./);
		assert.equal(VALUE_DIAL_SPEC.trigger.Rotate, "Next value (pressed: next sensor)");
		assert.match(VALUE_DIAL_SPEC.trigger.Push, /^Reload/);
		assert.equal(DIAL_SPEC.name, "Custom Dial");
		assert.match(DIAL_SPEC.tooltip, /^Freely configurable/);
		assert.match(DIAL_SPEC.tooltip, /Default: turn for the next value, press for the next sensor, turn while pressed for the next station\./);
		assert.match(DIAL_SPEC.trigger.Push, /default: next sensor/);
	});

	it("no tooltip is empty or promises more than it does", () => {
		for (const spec of specs) {
			assert.ok(spec.tooltip.length > 30, spec.id);
			assert.doesNotMatch(spec.tooltip, /instant|real[- ]time|live/i, spec.id);
		}
	});

	it("the generated manifest carries the same text (run npm run generate:manifest)", () => {
		const tips = manifest.Actions.map((a) => a.Tooltip);
		for (const spec of specs) assert.ok(tips.includes(spec.tooltip), spec.id);
		const encoders = manifest.Actions.filter((a) => a.Encoder);
		assert.equal(encoders.length, 3);
		for (const a of encoders) assert.match(a.Encoder!.TriggerDescription.Touch, /once a minute/);
	});

	it("the source comments do not claim a press is never a request", () => {
		for (const file of ["src/actions/key-controller.ts", "src/actions/dial-controller.ts", "src/actions/nav-controller.ts"]) {
			const text = readFileSync(join(ROOT, file), "utf-8");
			assert.doesNotMatch(text, /never\s+an\s+API\s+call|never\s+causes/i, file);
			assert.match(text, /once a minute|one real\s+request per minute/, file);
		}
	});
});

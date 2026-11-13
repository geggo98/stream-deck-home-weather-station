/** A key press asks for a refresh that is rate-limited to one request per minute; the wording must say so. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PLUGIN_DIR_NAME } from "../scripts/lib/plugin-id.ts";
import { DIAL_SPEC, FOCUS_SPECS, KEYPAD_SPECS } from "../src/actions/catalog.ts";

const ROOT = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, PLUGIN_DIR_NAME, "manifest.json"), "utf-8")) as { Actions: Array<{ Tooltip: string; Encoder?: { TriggerDescription: { Push: string; Touch: string } } }> };

describe("press wording", () => {
	const specs = [...KEYPAD_SPECS, ...FOCUS_SPECS, DIAL_SPEC];

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

	it("the dial says tap = reload at most once a minute, and what push and rotate do", () => {
		assert.match(DIAL_SPEC.tooltip, /Tap the strip to request fresh data \(at most once a minute\)/);
		assert.match(DIAL_SPEC.trigger.Touch, /reload \(once a minute at most\)/);
		assert.equal(DIAL_SPEC.trigger.Push, "Next sensor");
		assert.match(DIAL_SPEC.trigger.Rotate, /Next value.*next station/);
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
		const touch = manifest.Actions.find((a) => a.Encoder)?.Encoder?.TriggerDescription as { Touch: string } | undefined;
		assert.match(touch?.Touch ?? "", /once a minute/);
	});

	it("the source comments do not claim a press is never a request", () => {
		for (const file of ["src/actions/key-controller.ts", "src/actions/dial-controller.ts", "src/actions/nav-controller.ts"]) {
			const text = readFileSync(join(ROOT, file), "utf-8");
			assert.doesNotMatch(text, /never\s+an\s+API\s+call|never\s+causes/i, file);
			assert.match(text, /once a minute|one real\s+request per minute/, file);
		}
	});
});

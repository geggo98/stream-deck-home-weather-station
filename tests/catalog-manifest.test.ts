/**
 * The catalog, the manifest and the code must agree on every action.
 *
 * `registerAction` throws for a UUID that is missing from the manifest, and that error is
 * swallowed by the plugin's uncaughtException net, so a drift would show up as a key that
 * silently never works. This test makes it loud.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTION_IDS, catalogGlyphs, DIAL_SPEC, FOCUS_SPECS, KEYPAD_SPECS, PLUGIN_ID, uuidFor } from "../src/actions/catalog.ts";
import { GLYPH_NAMES } from "../src/render/glyph-names.ts";
import { GLYPHS } from "../src/render/generated/glyphs.ts";
import { buildManifest, serialiseManifest, type Manifest } from "../scripts/lib/manifest.ts";
import { PLUGIN_DIR_NAME, PLUGIN_ID as SCRIPT_PLUGIN_ID } from "../scripts/lib/plugin-id.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_FILE = join(ROOT, PLUGIN_DIR_NAME, "manifest.json");
const committedText = readFileSync(MANIFEST_FILE, "utf-8");
const committed = JSON.parse(committedText) as Manifest;

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".ts"))
		.map((e) => readFileSync(join(dir, e.name), "utf-8"));
}

describe("manifest drift", () => {
	it("equals what the generator would write from the catalog", () => {
		assert.equal(committedText, serialiseManifest(buildManifest(committed)), "run `npm run generate:manifest`");
	});

	it("registers exactly the catalog's actions, in order", () => {
		assert.deepEqual(committed.Actions.map((a) => a.UUID), ACTION_IDS.map(uuidFor));
	});

	it("keeps the plugin id in step between runtime and scripts, and folder name follows it", () => {
		assert.equal(PLUGIN_ID, SCRIPT_PLUGIN_ID);
		assert.equal(PLUGIN_DIR_NAME, `${PLUGIN_ID}.sdPlugin`);
		assert.equal(committed.UUID, PLUGIN_ID);
		for (const a of committed.Actions) assert.ok(a.UUID.startsWith(`${PLUGIN_ID}.`), a.UUID);
	});

	it("declares keys as Keypad and the dial as Encoder with a built-in layout", () => {
		for (const spec of KEYPAD_SPECS) {
			const a = committed.Actions.find((x) => x.UUID === uuidFor(spec.id))!;
			assert.deepEqual(a.Controllers, ["Keypad"]);
			assert.equal(a.PropertyInspectorPath, "ui/measurement.html");
			assert.equal(a.Encoder, undefined);
		}
		for (const spec of FOCUS_SPECS) {
			const a = committed.Actions.find((x) => x.UUID === uuidFor(spec.id))!;
			assert.deepEqual(a.Controllers, ["Keypad"], spec.id);
			assert.equal(a.PropertyInspectorPath, "propertyInspector" in spec ? spec.propertyInspector : undefined, spec.id);
			assert.equal(a.Encoder, undefined);
		}
		const dial = committed.Actions.find((x) => x.UUID === uuidFor(DIAL_SPEC.id))!;
		assert.deepEqual(dial.Controllers, ["Encoder"]);
		assert.equal(dial.PropertyInspectorPath, "ui/dial.html");
		assert.equal(dial.Encoder?.layout, "$B1");
	});
});

describe("every catalog UUID is registered in code", () => {
	const actionSources = sources(join(ROOT, "src/actions")).join("\n");

	it("has an @action decorator for each catalog id and none for anything else", () => {
		const decorated = [...actionSources.matchAll(/@action\(\{\s*UUID:\s*uuidFor\(([^)]*)\)/g)].map((m) => m[1]!.trim());
		const expected = [...KEYPAD_SPECS.map((s) => JSON.stringify(s.id)), ...FOCUS_SPECS.map((s) => JSON.stringify(s.id)), "DIAL_SPEC.id"];
		assert.deepEqual([...decorated].sort(), [...expected].sort());
		assert.equal(decorated.length, ACTION_IDS.length);
	});

	it("every focus action class is created by createFocusActions, once", () => {
		const text = readFileSync(join(ROOT, "src/actions/focus-keys.ts"), "utf-8");
		const classes = [...text.matchAll(/@action\(\{[^\n]*\}\)\s*export class (\w+)/g)].map((m) => m[1]!);
		const created = [...(/createFocusActions\(\)[^{]*\{\s*return \[([\s\S]*?)\];/.exec(text)?.[1] ?? "").matchAll(/new (\w+)\(\)/g)].map((m) => m[1]!);
		assert.equal(classes.length, FOCUS_SPECS.length);
		assert.deepEqual([...created].sort(), [...classes].sort());
	});

	it("never hard-codes the plugin id outside the catalog", () => {
		for (const file of readdirSync(join(ROOT, "src/actions")).filter((f) => f.endsWith(".ts") && f !== "catalog.ts")) {
			assert.equal(readFileSync(join(ROOT, "src/actions", file), "utf-8").includes(PLUGIN_ID), false, file);
		}
	});

	it("plugin.ts registers the dial and every keypad action", () => {
		const plugin = readFileSync(join(ROOT, "src/plugin.ts"), "utf-8");
		assert.match(plugin, /createKeypadActions\(\)/);
		assert.match(plugin, /createFocusActions\(\)/);
		assert.match(plugin, /new WeatherDialAction\(\)/);
	});
});

describe("generated glyph module", () => {
	it("contains only generated content and exactly the glyphs that are needed", () => {
		const text = readFileSync(join(ROOT, "src/render/generated/glyphs.ts"), "utf-8");
		assert.match(text, /^\/\/ GENERATED by scripts\/generate-icons\.ts/);
		const exports = [...text.matchAll(/^export /gm)];
		assert.equal(exports.length, 1, "nothing but GLYPHS is exported from a generated file");
		const needed = [...new Set<string>([...GLYPH_NAMES, ...catalogGlyphs()])].sort();
		assert.deepEqual(Object.keys(GLYPHS).sort(), needed, "run `npm run generate:icons`");
	});

	it("carries only Lucide path data, no script or event handler", () => {
		for (const [name, markup] of Object.entries(GLYPHS)) {
			assert.match(markup, /^(<(path|circle|line|rect|polyline|polygon|ellipse)\b[^<>]*\/>\s*)+$/, name);
			assert.equal(/script|on\w+=/i.test(markup), false, name);
		}
	});
});

/**
 * Encoder layouts, checked here rather than only at pack time.
 *
 * The dial uses the built-in `$B1` layout and switches to one custom layout (the history
 * strip) on a long touch; this test validates every layout file
 * with the rules from Elgato's layout schema: a 200x100 canvas, unique keys, and items that
 * share a zOrder must not overlap. An unknown item key in `setFeedback` is silently
 * ignored by Stream Deck, so the keys the dial writes are pinned to the built-in layout's.
 */
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { DIAL_ITEM_KEYS, HISTORY_CHART_SIZE, HISTORY_ITEM_KEYS, HISTORY_LAYOUT } from "../src/render/dial-feedback.ts";
import { PLUGIN_DIR } from "../scripts/lib/plugin-id.ts";
import type { Manifest } from "../scripts/lib/manifest.ts";

const BUILT_IN_LAYOUTS = ["$X1", "$A0", "$A1", "$B1", "$B2", "$C1"];
/** Item keys of the built-in `$B1` layout, as documented by Elgato (not read from a file). */
const B1_KEYS = ["icon", "title", "value", "indicator"];

interface Item {
	key: string;
	type: string;
	rect: [number, number, number, number];
	zOrder?: number;
}

const manifest = JSON.parse(readFileSync(resolve(PLUGIN_DIR, "manifest.json"), "utf-8")) as Manifest;
const layoutDir = resolve(PLUGIN_DIR, "layouts");
const layoutFiles = existsSync(layoutDir) ? readdirSync(layoutDir).filter((f) => f.endsWith(".json")) : [];

function overlaps(a: Item, b: Item): boolean {
	const [ax, ay, aw, ah] = a.rect;
	const [bx, by, bw, bh] = b.rect;
	return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

describe("encoder layouts", () => {
	it("every manifest layout is built in or an existing file", () => {
		for (const a of manifest.Actions) {
			if (!a.Encoder) continue;
			const layout = a.Encoder.layout;
			assert.ok(BUILT_IN_LAYOUTS.includes(layout) || existsSync(resolve(PLUGIN_DIR, layout)), `${a.Name}: ${layout}`);
		}
	});

	it("the dial writes exactly the item keys of the $B1 layout it declares", () => {
		const dial = manifest.Actions.find((a) => a.Encoder)!;
		assert.equal(dial.Encoder?.layout, "$B1");
		assert.deepEqual([...DIAL_ITEM_KEYS].sort(), [...B1_KEYS].sort());
	});

	it("the history strip layout declares exactly the items the dial writes, with the chart size the renderer draws", () => {
		assert.ok(layoutFiles.includes("history-strip.json"));
		assert.equal(HISTORY_LAYOUT, "layouts/history-strip.json");
		const layout = JSON.parse(readFileSync(join(layoutDir, "history-strip.json"), "utf-8")) as { items: Item[] };
		assert.deepEqual(layout.items.map((i) => i.key).sort(), [...HISTORY_ITEM_KEYS].sort());
		const chart = layout.items.find((i) => i.key === "chart")!;
		assert.equal(chart.type, "pixmap");
		assert.deepEqual([chart.rect[2], chart.rect[3]], [HISTORY_CHART_SIZE.width, HISTORY_CHART_SIZE.height]);
	});

	for (const file of layoutFiles) {
		it(`layouts/${file} is valid`, () => {
			const layout = JSON.parse(readFileSync(join(layoutDir, file), "utf-8")) as { id: string; items: Item[] };
			assert.ok(layout.id && Array.isArray(layout.items));
			const keys = new Set<string>();
			for (const item of layout.items) {
				assert.ok(!keys.has(item.key), `duplicate key ${item.key}`);
				keys.add(item.key);
				const [x, y, w, h] = item.rect;
				assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 200 && y + h <= 100, `${item.key} leaves the 200x100 canvas`);
			}
			for (const a of layout.items) {
				for (const b of layout.items) {
					if (a.key < b.key && (a.zOrder ?? 0) === (b.zOrder ?? 0)) assert.ok(!overlaps(a, b), `${a.key} overlaps ${b.key} at the same zOrder`);
				}
			}
		});
	}
});

/** The key shows MAX_LABEL_CHARS characters of a label; the Property Inspector must not allow more. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PLUGIN_DIR_NAME } from "../scripts/lib/plugin-id.ts";
import { buildKeyView } from "../src/render/key-view.ts";
import { cleanLabel, MAX_LABEL_CHARS } from "../src/render/title.ts";
import { baseModule, BASE_ID, makeSnapshot, NOW, STATION_ID } from "./actions-fixtures.ts";
import { makeModuleKey } from "../src/render/select.ts";

const PI = join(resolve(import.meta.dirname, ".."), PLUGIN_DIR_NAME, "ui/measurement.html");

describe("label limit", () => {
	it("is 9 and cuts longer labels with an ellipsis", () => {
		assert.equal(MAX_LABEL_CHARS, 9);
		assert.equal(cleanLabel("abcdefghi"), "abcdefghi");
		assert.equal(cleanLabel("abcdefghij"), "abcdefgh…");
		const title = buildKeyView({
			metric: "temperature",
			settings: { moduleKey: makeModuleKey(STATION_ID, BASE_ID), label: "A label of more than twelve" },
			global: {},
			hasSource: true,
			connection: { kind: "ok" },
			snapshot: makeSnapshot([baseModule()]),
			now: NOW,
		}).title;
		assert.match(title ?? "", /\nA label …$/);
	});

	it("matches the maxlength of the label field in the Property Inspector", () => {
		const html = readFileSync(PI, "utf-8");
		const field = /<sdpi-textfield\b[^>]*\bsetting="label"[^>]*>/.exec(html)?.[0];
		assert.ok(field, "no label field found in measurement.html");
		const maxlength = /\bmaxlength="(\d+)"/.exec(field)?.[1];
		assert.equal(Number(maxlength), MAX_LABEL_CHARS, "a longer field promises text the key cannot show");
	});
});

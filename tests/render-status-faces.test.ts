/**
 * A key's text lives in the native title, which Stream Deck ignores while the user has typed a
 * custom title (SDK typings of Key.setTitle). The plugin cannot detect that, so the picture
 * must carry what it can: every status has its own face, and with bigText the value is
 * drawn into the image.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildKeyView, type KeyViewInput } from "../src/render/key-view.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { baseModule, BASE_ID, makeSnapshot, MIN, NOW, STATION_ID } from "./actions-fixtures.ts";

const moduleKey = makeModuleKey(STATION_ID, BASE_ID);
const base: KeyViewInput = {
	metric: "co2",
	settings: { moduleKey },
	global: {},
	hasSource: true,
	connection: { kind: "ok" },
	snapshot: makeSnapshot(),
	now: NOW,
};

describe("status faces without title text", () => {
	const faces: Record<string, Partial<KeyViewInput>> = {
		"no-credentials": { connection: { kind: "no-credentials" } },
		"auth-error": { connection: { kind: "auth-error", message: "x", since: 0 } },
		"loading": { snapshot: undefined, connection: { kind: "loading" } },
		"offline": { snapshot: undefined, connection: { kind: "error", message: "x", since: 0, retryAt: 1 } },
		"no-module": { settings: { moduleKey: makeModuleKey(STATION_ID, "00:00:5e:00:53:ff") } },
		"unreachable": { snapshot: makeSnapshot([baseModule({ reachable: false, measuredAt: NOW - 300 * MIN })]) },
		"no-data": { snapshot: makeSnapshot([baseModule({ values: { temperature: 20 } })]) },
		"value": {},
	};

	it("gives every status a picture of its own, so it is recognisable without the title", () => {
		const svgs = new Map<string, string>();
		for (const [name, extra] of Object.entries(faces)) {
			const view = buildKeyView({ ...base, ...extra });
			assert.equal(view.classification.kind, name, name);
			svgs.set(name, view.svg);
		}
		const distinct = new Set(svgs.values());
		assert.equal(distinct.size, svgs.size, `two statuses share a picture: ${[...svgs.keys()].join(", ")}`);
	});

	it("with bigText the value is in the image and not in the title", () => {
		const view = buildKeyView({ ...base, settings: { moduleKey, bigText: true } });
		assert.match(view.svg, /612/);
		assert.doesNotMatch(view.title ?? "", /612/);
		const plain = buildKeyView(base);
		assert.doesNotMatch(plain.svg, /612/);
		assert.match(plain.title ?? "", /612/);
	});
});

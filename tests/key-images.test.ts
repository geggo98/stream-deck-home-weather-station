/**
 * Every picture the plugin can ask for has to exist, and every composed image has to be
 * a data URI.
 *
 * A manifest path that does not resolve leaves the key blank with nothing in any log, and
 * `setImage` with a raw SVG string is silently ignored on hardware (measured in a sibling
 * project). Both are silent failures, so they are asserted here.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { KeyController } from "../src/actions/key-controller.ts";
import { DialController } from "../src/actions/dial-controller.ts";
import { HistoryController } from "../src/actions/history-controller.ts";
import { NavController } from "../src/actions/nav-controller.ts";
import type { NavKind } from "../src/render/nav-view.ts";
import { ACTION_IDS, iconPath, keyImagePath } from "../src/actions/catalog.ts";
import { isSvgDataUri } from "../src/render/data-uri.ts";
import { DISPLAY_METRIC_IDS } from "../src/render/metrics.ts";
import { PLUGIN_DIR } from "../scripts/lib/plugin-id.ts";
import type { Manifest } from "../scripts/lib/manifest.ts";
import type { ConnectionState } from "../src/adapter/station/types.ts";
import {
	baseModule,
	BASE_ID,
	decodeSvg,
	FakeService,
	FakeSource,
	makeEnv,
	makeFocusStore,
	makeTwoStationSnapshot,
	settle,
	makeSnapshot,
	MIN,
	NOW,
	RecordingDialSurface,
	RecordingKeySurface,
	STATION_ID,
} from "./actions-fixtures.ts";
import { makeModuleKey } from "../src/render/select.ts";

const manifest = JSON.parse(readFileSync(resolve(PLUGIN_DIR, "manifest.json"), "utf-8")) as Manifest;

/** Stream Deck resolves an extension-less path to .svg or .png (with @2x variants). */
function resolves(path: string): boolean {
	return [".svg", ".png"].some((ext) => existsSync(resolve(PLUGIN_DIR, path + ext)));
}

describe("manifest image paths", () => {
	it("every action icon and state image exists", () => {
		const missing: string[] = [];
		for (const a of manifest.Actions) {
			for (const path of [a.Icon, ...a.States.map((s) => s.Image), ...(a.Encoder ? [a.Encoder.Icon] : [])]) {
				if (!resolves(path)) missing.push(path);
			}
		}
		assert.deepEqual(missing, [], "run `npm run generate:icons`");
	});

	it("matches the catalog's naming rule", () => {
		for (const id of ACTION_IDS) {
			assert.ok(resolves(iconPath(id)), iconPath(id));
			assert.ok(resolves(keyImagePath(id)), keyImagePath(id));
		}
	});

	it("plugin and category icons exist once the rendering step has delivered them", (t) => {
		// Owned by the rendering step (imgs/plugin/**). Until it has delivered anything, say so
		// instead of failing the plugin layer; once any file is there, ALL of them must be.
		const required = ["imgs/plugin/plugin-icon.png", "imgs/plugin/plugin-icon@2x.png", "imgs/plugin/category-icon.png", "imgs/plugin/category-icon@2x.png"];
		const present = required.filter((p) => existsSync(resolve(PLUGIN_DIR, p)));
		if (present.length === 0) {
			t.skip("imgs/plugin/* not delivered yet");
			return;
		}
		assert.deepEqual(required.filter((p) => !present.includes(p)), []);
		assert.equal(manifest.Icon, "imgs/plugin/plugin-icon");
		assert.equal(manifest.CategoryIcon, "imgs/plugin/category-icon");
	});
});

describe("generated picture files", () => {
	it("list icons are 20x20 white SVG, key tiles 144x144 without any text", () => {
		for (const id of ACTION_IDS) {
			const icon = readFileSync(resolve(PLUGIN_DIR, iconPath(id) + ".svg"), "utf-8");
			assert.match(icon, /width="20" height="20"/, id);
			assert.match(icon, /stroke="#FFFFFF"/, id);
			const key = readFileSync(resolve(PLUGIN_DIR, keyImagePath(id) + ".svg"), "utf-8");
			assert.match(key, /width="144" height="144"/, id);
			assert.equal(key.includes("<text"), false, `${id}: placeholder tiles carry no text`);
		}
	});

	it("ship Lucide's licence, with the Feather notice and the list of used icons", () => {
		const licence = readFileSync(resolve(PLUGIN_DIR, "imgs/icons/LICENSE-lucide.txt"), "utf-8");
		assert.match(licence, /ISC License/);
		assert.match(licence, /The MIT License \(MIT\)/);
		assert.match(licence, /Feather-derived: .*arrow-up/);
		assert.match(licence, /ISC only: .*thermometer/);
	});
});

describe("composed images are data URIs, for every status", () => {
	const connections: ConnectionState[] = [
		{ kind: "ok" },
		{ kind: "loading" },
		{ kind: "no-credentials" },
		{ kind: "auth-error", message: "x", since: NOW },
		{ kind: "error", message: "x", since: NOW, retryAt: NOW + MIN },
	];
	const snapshots = [
		makeSnapshot(),
		makeSnapshot([baseModule({ measuredAt: NOW - 60 * MIN })]),
		makeSnapshot([baseModule({ reachable: false, measuredAt: NOW - 240 * MIN })]),
		undefined,
	];

	it("never hands a raw SVG string to a key's setImage", async () => {
		let checked = 0;
		for (const snapshot of snapshots) {
			for (const state of connections) {
				for (const metric of DISPLAY_METRIC_IDS) {
					const source = new FakeSource(snapshot);
					source.state = state;
					const controller = new KeyController(makeEnv(source));
					const key = new RecordingKeySurface();
					await controller.appear(key, { moduleKey: makeModuleKey(STATION_ID, BASE_ID), showTrend: true, showMinMax: true, bigText: true }, metric);
					const sensorFocus = new RecordingKeySurface("sensor-focus");
					await controller.appear(sensorFocus, { metric, showTrend: true, showMinMax: true, bigText: true }, { metric: "temperature", follow: "sensor" });
					for (const image of sensorFocus.images) assert.ok(image && isSvgDataUri(image), `sensor focus ${metric}/${state.kind}`);
					for (const image of key.images) {
						assert.ok(image && isSvgDataUri(image), `${metric}/${state.kind}`);
						const svg = decodeSvg(image);
						assert.match(svg, /^<svg [^>]*width="144" height="144"/);
						assert.equal(svg.split("<g ").length, svg.split("</g>").length, "balanced groups");
						assert.equal(/<script|javascript:|on\w+=/i.test(svg), false);
						checked++;
					}
					controller.dispose();
				}
			}
		}
		assert.ok(checked >= snapshots.length * connections.length * DISPLAY_METRIC_IDS.length, "the scan saw every combination");
	});

	it("never hands a raw SVG string to a dial's icon either", async () => {
		for (const snapshot of snapshots) {
			for (const state of connections) {
				const source = new FakeSource(snapshot);
				source.state = state;
				const controller = new DialController(makeEnv(source));
				const dial = new RecordingDialSurface();
				await controller.appear(dial, { moduleKey: makeModuleKey(STATION_ID, BASE_ID) });
				assert.ok(dial.feedback.length >= 1);
				for (const payload of dial.feedback) assert.ok("icon" in payload && isSvgDataUri(payload.icon.value), state.kind);
				controller.dispose();
			}
		}
	});

	it("never hands a raw SVG string to the navigation, history or strip faces", async () => {
		const kinds: NavKind[] = ["refresh", "next-metric", "prev-metric", "next-sensor", "prev-sensor", "next-station", "prev-station", "auto-rotate", "info"];
		let checked = 0;
		for (const snapshot of [...snapshots.slice(0, 3), makeTwoStationSnapshot(), undefined]) {
			for (const state of connections) {
				const service = new FakeService(snapshot);
				service.state = state;
				const { store } = makeFocusStore();
				const env = makeEnv(service, { focus: store });
				const nav = new NavController(env);
				for (const kind of kinds) {
					const key = new RecordingKeySurface(kind);
					await nav.appear(key, {}, kind);
					nav.press(kind);
					for (const image of key.images) {
						assert.ok(image && isSvgDataUri(image), `${kind}/${state.kind}`);
						assert.match(decodeSvg(image), /^<svg [^>]*width="144" height="144"/);
						checked++;
					}
				}
				const history = new HistoryController(env);
				const hkey = new RecordingKeySurface("history");
				await history.appear(hkey, {}, "temperature");
				await settle();
				for (const image of hkey.images) {
					assert.ok(image && isSvgDataUri(image), `history/${state.kind}`);
					checked++;
				}
				const dial = new DialController({ ...env, persistMs: 5 });
				const strip = new RecordingDialSurface();
				await dial.appear(strip, {});
				dial.hold(strip.id);
				dial.hold(strip.id);
				await settle();
				for (const payload of strip.feedback) {
					const picture = "icon" in payload ? payload.icon.value : payload.chart.value;
					assert.ok(isSvgDataUri(picture), `strip/${state.kind}`);
					checked++;
				}
				nav.dispose();
				history.dispose();
				dial.dispose();
			}
		}
		assert.ok(checked > 300, `the scan saw ${checked} images`);
	});
});

/**
 * Guards the shipped manifest against the states that break it or break the brand rules.
 *
 *  - `Nodejs.Debug: "enabled"` ships an inspector port and TRACE logging; `"disabled"`
 *    makes Stream Deck refuse to launch the plugin (exit code 1 before any JS runs, nothing
 *    in the plugin's own log). The release state is the key being ABSENT.
 *  - Version must be 4-part and derive from package.json.
 *  - Name, Category, Author and every UUID stay free of the brand names (docs/ARCHITECTURE.md).
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PLUGIN_DIR_NAME } from "../scripts/lib/plugin-id.ts";
import type { Manifest } from "../scripts/lib/manifest.ts";

const ROOT = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL(`${PLUGIN_DIR_NAME}/manifest.json`, ROOT), "utf-8")) as Manifest;
const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf-8")) as { version: string };

/** Words that must not appear in identifying manifest fields. */
const BRAND_WORDS = /netatmo|elgato|stream\s*deck|streamdeck|corsair|plugin/i;

/** -1, 0 or 1 for MAJOR.MINOR.PATCH strings (numeric per part). */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

describe("shipped manifest", () => {
	it("has no Nodejs.Debug key", () => {
		const nodejs = (manifest.Nodejs ?? {}) as { Debug?: unknown };
		assert.equal("Debug" in nodejs, false, `found ${JSON.stringify(nodejs.Debug)}; run \`npm run build\` to remove it`);
	});

	it("targets the Node runtime the code is built for and the built bundle", () => {
		assert.equal(manifest.Nodejs.Version, "24");
		assert.equal(manifest.CodePath, "bin/plugin.js");
		assert.equal(manifest.SDKVersion, 3);
		assert.equal(manifest.Software.MinimumVersion, "7.1");
	});

	it("lists exactly mac 12 and windows 10 (no linux)", () => {
		assert.deepEqual(manifest.OS, [
			{ Platform: "mac", MinimumVersion: "12" },
			{ Platform: "windows", MinimumVersion: "10" },
		]);
	});

	// The committed manifest may LAG package.json by one release: release-please bumps package.json in the
	// release PR and `npm run build` (sync-manifest-version.ts) derives the 4-part manifest version from it,
	// so the packed file is always right (docs/PUBLISHING.md). What must never happen: the manifest AHEAD of
	// package.json, or a version the Stream Deck CLI rejects (not four numeric parts, build number not 0).
	it("has a 4-part version that is never ahead of package.json (it may lag one release until the next build)", () => {
		assert.match(manifest.Version, /^\d+\.\d+\.\d+\.0$/, "four numeric parts with build number 0, as the build writes it");
		const wanted = pkg.version.split(/[-+]/)[0] as string;
		assert.ok(compareVersions(manifest.Version.replace(/\.0$/, ""), wanted) <= 0, `manifest ${manifest.Version} is ahead of package.json ${pkg.version}`);
	});

	it("the version comparison used above can fail (negative control)", () => {
		assert.equal(compareVersions("0.1.2", "0.1.3"), -1);
		assert.equal(compareVersions("0.1.3", "0.1.3"), 0);
		assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
		assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
	});

	it("keeps brand words out of Name, Category, Author, UUIDs and the folder name", () => {
		const fields: Record<string, string> = {
			Name: manifest.Name,
			Category: manifest.Category,
			Author: manifest.Author,
			UUID: manifest.UUID,
			folder: PLUGIN_DIR_NAME.replace(/\.sdPlugin$/, ""), // the suffix is mandated by Stream Deck
		};
		manifest.Actions.forEach((a, i) => {
			fields[`Actions[${i}].Name`] = a.Name;
			fields[`Actions[${i}].UUID`] = a.UUID;
		});
		for (const [field, value] of Object.entries(fields)) {
			assert.equal(BRAND_WORDS.test(value), false, `${field}: ${value}`);
		}
	});

	it("names the data source only as a compatibility statement with the non-affiliation notice", () => {
		assert.match(manifest.Description, /Unofficial: independent project, not affiliated with or endorsed by Netatmo, Elgato or Corsair\./);
		assert.match(manifest.Description, /from a Netatmo weather station/);
		const mentions = manifest.Description.match(/Netatmo/g) ?? [];
		assert.equal(mentions.length, 2, "once as compatibility, once in the notice");
	});

	it("uses the expected identity fields", () => {
		assert.equal(manifest.Name, "Home Weather Station");
		assert.equal(manifest.Category, manifest.Name);
		assert.equal(manifest.UUID, "de.schwetschke.sd.home-weather-station");
		assert.equal(manifest.Icon, "imgs/plugin/plugin-icon");
		assert.equal(manifest.CategoryIcon, "imgs/plugin/category-icon");
		assert.equal(manifest.URL, "https://github.com/geggo98/stream-deck-home-weather-station");
	});

	it("has unique action UUIDs and names", () => {
		assert.equal(new Set(manifest.Actions.map((a) => a.UUID)).size, manifest.Actions.length);
		assert.equal(new Set(manifest.Actions.map((a) => a.Name)).size, manifest.Actions.length);
	});
});

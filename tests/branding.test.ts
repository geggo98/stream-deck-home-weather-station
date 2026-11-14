/**
 * Brand hygiene (see docs/BRANDING.md): a trademark owner's name must not work as part of
 * this project's identity. Identity means manifest Name/Category/Author, every UUID, file and
 * folder names, image file names and package names. Running text may name the brand as a
 * compatibility statement, next to the non-affiliation notice.
 *
 * Each checker is validated against a deliberately bad sample, because a check that cannot
 * fail would report the same as a clean tree. The manifest is written by another part of the
 * build; until it exists the manifest test is skipped with a visible reason, and it fails
 * as soon as the file exists and violates a rule.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "de.schwetschke.sd.home-weather-station.sdPlugin", "manifest.json");

const IDENTITY_FORBIDDEN = /netatmo|elgato|stream\s*deck|streamdeck|corsair|legrand|plugin/i;
const PATH_FORBIDDEN = /netatmo|elgato|streamdeck/i;
const LOGO_NAME = /logo|wordmark|brand|netatmo|elgato|corsair|legrand/i;
const IMAGE_EXT = new Set([".png", ".svg", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns"]);

interface Manifest {
	Name?: string;
	Category?: string;
	Author?: string;
	UUID?: string;
	Description?: string;
	Actions?: { UUID?: string }[];
}

export function manifestViolations(m: Manifest): string[] {
	const out: string[] = [];
	const check = (label: string, value: string | undefined) => {
		if (value === undefined) out.push(`${label} is missing`);
		else if (IDENTITY_FORBIDDEN.test(value)) out.push(`${label} contains a brand word or "plugin": ${JSON.stringify(value)}`);
	};
	check("Name", m.Name);
	check("Category", m.Category);
	check("Author", m.Author);
	check("UUID", m.UUID);
	(m.Actions ?? []).forEach((a, i) => check(`Actions[${i}].UUID`, a.UUID));
	// Naming the brand in the description is allowed as a compatibility statement, but only
	// together with the disclaimer.
	if (/station/i.test(m.Description ?? "") && !/not affiliated/i.test(m.Description ?? "")) {
		out.push('Description mentions Netatmo without "not affiliated"');
	}
	return out;
}

export function pathViolations(paths: readonly string[]): string[] {
	// One entry per offending file or folder (not per file below it), so a folder rename is
	// reported once.
	const out = new Set<string>();
	for (const p of paths) {
		const segs = p.split("/");
		segs.forEach((seg, i) => {
			if (seg.endsWith(".streamDeckPlugin")) return; // the packed file's mandated extension
			if (PATH_FORBIDDEN.test(seg)) out.add(segs.slice(0, i + 1).join("/"));
		});
	}
	return [...out].sort().map((p) => `${p} contains a brand word`);
}

export function logoViolations(paths: readonly string[]): string[] {
	return paths
		.filter((p) => IMAGE_EXT.has(extname(p).toLowerCase()))
		.filter((p) => LOGO_NAME.test(p.split("/").pop() ?? p))
		.map((p) => `${p}: image name suggests a logo or brand artwork`);
}

export function readmeViolations(readme: string): string[] {
	const head = readme.split("\n").slice(0, 15).join("\n");
	return /not affiliated/i.test(head) ? [] : ['README does not say "not affiliated" within its first 15 lines'];
}

export function noticeViolations(notice: string): string[] {
	const out: string[] = [];
	if (!/trademarks? and non-affiliation/i.test(notice)) out.push("NOTICE lacks the trademark paragraph heading");
	if (!/not affiliated/i.test(notice)) out.push('NOTICE lacks "not affiliated"');
	if (!/trademarks? of/i.test(notice)) out.push('NOTICE does not say whose trademarks the names are');
	return out;
}

function listFiles(): string[] {
	const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return out
		.split("\0")
		.filter((p) => p.length > 0)
		.filter((p) => existsSync(join(root, p)) || lstatSync(join(root, p), { throwIfNoEntry: false })?.isSymbolicLink());
}

// ---- validation of the checkers -----------------------------------------------------------

test("checker validation: bad samples are flagged, good ones pass", () => {
	const bad: Manifest = {
		Name: "Netatmo Weather",
		Category: "Stream Deck Extras",
		Author: "Elgato Fan",
		UUID: "com.netatmo.weather",
		Description: "Shows data from a Netatmo station",
		Actions: [{ UUID: "com.netatmo.weather.temperature" }, { UUID: "x.streamdeck.y" }],
	};
	assert.ok(manifestViolations(bad).length >= 7, manifestViolations(bad).join("\n"));
	const good: Manifest = {
		Name: "Home Weather Station",
		Category: "Home Weather Station",
		Author: "Some Author",
		UUID: "de.example.sd.home-weather-station",
		Description: "Works with a Netatmo weather station. Unofficial, not affiliated with Netatmo.",
		Actions: [{ UUID: "de.example.sd.home-weather-station.temperature" }],
	};
	assert.deepEqual(manifestViolations(good), []);

	assert.equal(pathViolations(["src/netatmo-client.ts", "a/Elgato/b.png", "ok/file.ts", "x.streamDeckPlugin"]).length, 2);
	assert.equal(logoViolations(["imgs/netatmo-logo.png", "imgs/brand.svg", "imgs/temperature.svg", "docs/logo.md"]).length, 2);
	assert.equal(readmeViolations("# Title\n\nSome text").length, 1);
	assert.equal(readmeViolations("# T\n> This is not affiliated with X.").length, 0);
	assert.ok(noticeViolations("just a licence").length >= 2);
});

// ---- the repository ---------------------------------------------------------------------------

test("manifest identity contains no brand word and no 'plugin'", {
	skip: existsSync(manifestPath) ? false : "manifest.json does not exist yet (written by the plugin-layer part)",
}, () => {
	const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
	assert.ok((m.Actions ?? []).length > 0, "manifest has no actions: the UUID check would be vacuous");
	assert.deepEqual(manifestViolations(m), []);
});

// Decision (docs/BRANDING.md, two tiers): the four company names never appear in the package or
// repository name; "Stream Deck" may, as the descriptive slug, and nowhere else in the identity.
const COMPANY_NAMES = /netatmo|elgato|corsair|legrand/i;

export function packageNameViolations(name: string, repoName: string, brandingDoc: string): string[] {
	const out: string[] = [];
	if (COMPANY_NAMES.test(name)) out.push(`package name contains a company name: ${name}`);
	if (COMPANY_NAMES.test(repoName)) out.push(`repository name contains a company name: ${repoName}`);
	if (/plugin/i.test(name)) out.push(`package name contains "plugin": ${name}`);
	if (name !== repoName) out.push(`package name ${name} and repository name ${repoName} differ`);
	if (!brandingDoc.includes(name)) out.push(`docs/BRANDING.md does not mention the slug ${name}, so the rule and the name may have diverged`);
	// The old text forbade "Stream Deck" in npm package names while the package is named after it.
	if (/npm package names\.\s*`tests\/branding\.test\.ts` enforces this/.test(brandingDoc)) {
		out.push("docs/BRANDING.md still claims that Stream Deck must not appear in npm package names");
	}
	return out;
}

test("package name checker: bad samples are flagged, the real slug passes", () => {
	assert.equal(packageNameViolations("netatmo-station", "netatmo-station", "x").length, 2 + 1);
	assert.ok(packageNameViolations("a", "b", "no slug here").length >= 2);
	assert.ok(
		packageNameViolations("x-slug", "x-slug", "xx x-slug. Elgato, Corsair and the word plugin do not appear in npm package names. `tests/branding.test.ts` enforces this.").length === 1,
	);
	assert.deepEqual(packageNameViolations("x-slug", "x-slug", "the slug x-slug is allowed"), []);
});

test("package.json name: no company name, agrees with the repository name and with docs/BRANDING.md", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		name: string;
		repository?: { url?: string };
	};
	const repoName = /\/([^/]+?)(?:\.git)?$/.exec(pkg.repository?.url ?? "")?.[1] ?? "";
	assert.ok(repoName.length > 0, "package.json has no repository url to compare the name with");
	const doc = readFileSync(join(root, "docs", "BRANDING.md"), "utf8");
	assert.deepEqual(packageNameViolations(pkg.name, repoName, doc), []);
});

test("no file or folder name carries a brand word (tracked and untracked, ignored paths excluded)", () => {
	const files = listFiles();
	assert.ok(files.length > 20, `only ${files.length} paths listed, the listing may be broken`);
	assert.deepEqual(
		pathViolations(files),
		[],
		"brand word in a path. Rename it (for example src/adapter/weather, docs/WEATHER-API.md); " +
			"the brand belongs in running text only, see docs/BRANDING.md",
	);
});

test("no image whose name suggests a logo or brand artwork", () => {
	const files = listFiles();
	assert.ok(files.some((p) => IMAGE_EXT.has(extname(p).toLowerCase())) || files.length > 20);
	assert.deepEqual(logoViolations(files), []);
});

test("README starts with the non-affiliation notice", () => {
	assert.deepEqual(readmeViolations(readFileSync(join(root, "README.md"), "utf8")), []);
});

test("NOTICE has the trademark paragraph", () => {
	assert.deepEqual(noticeViolations(readFileSync(join(root, "NOTICE"), "utf8")), []);
});

// matches:  <div class="pi-account-title">Weather station account</div>  ->  "Weather station account"
const PI_HEADING = /<(?:h[1-6]|title|legend)[^>]*>(?<t>[^<]*)<|class="pi-account-title"[^>]*>(?<a>[^<]*)</g;

export function piHeadingViolations(html: string): { headings: number; violations: string[] } {
	const texts = [...html.matchAll(PI_HEADING)].map((m) => (m.groups?.t ?? m.groups?.a ?? "").trim());
	return { headings: texts.length, violations: texts.filter((t) => /netatmo|elgato|corsair|legrand/i.test(t)).map((t) => `heading "${t}" carries a brand word`) };
}

test("checker validation: a branded Property Inspector heading is flagged", () => {
	const bad = piHeadingViolations('<title>Settings</title><div class="pi-account-title">Netatmo account</div>');
	assert.equal(bad.headings, 2);
	assert.equal(bad.violations.length, 1);
	assert.equal(piHeadingViolations('<div class="pi-account-title">Weather station account</div>').violations.length, 0);
});

test("Property Inspector headings and titles are brand-free (descriptive hints may name the brand)", () => {
	const dir = join(root, "de.schwetschke.sd.home-weather-station.sdPlugin", "ui");
	for (const f of ["measurement.html", "dial.html", "dial-sensor.html", "dial-value.html"]) {
		const { headings, violations } = piHeadingViolations(readFileSync(join(dir, f), "utf8"));
		assert.ok(headings >= 2, `${f}: only ${headings} headings seen, the pattern may be broken`);
		assert.deepEqual(violations, [], f);
	}
});

/**
 * The packed .streamDeckPlugin must carry the plugin's LICENSE and NOTICE and a notice file
 * with the licence text of every npm package that is inlined into bin/plugin.js (terser drops
 * the licence comments, and MIT/BSD require the notice to travel with the code).
 *
 * The generated files are produced by `npm run build` (scripts/lib/notices.mjs, wired into
 * rollup.config.mjs). The pack test runs the real CLI on a COPY of the plugin folder in a temp
 * directory, with `--output` there too: no .streamDeckPlugin is left in the repository, and
 * the CLI's habit of rewriting manifest.json (it drops the trailing newline) cannot touch the
 * real manifest, which tests/manifest-state.test.ts compares byte for byte.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PLUGIN_DIR_NAME } from "../scripts/lib/plugin-id.ts";
import { collectPackages, findLicenceFile, packageRootOf, readVendorHeader, renderThirdPartyNotices } from "../scripts/lib/notices.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN_DIR = join(ROOT, PLUGIN_DIR_NAME);
const BUNDLE = join(PLUGIN_DIR, "bin/plugin.js");
const CLI = join(ROOT, "node_modules/.bin/streamdeck");
const built = existsSync(BUNDLE);
const NOTICE_FILES = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt"] as const;

describe("notice generator", () => {
	it("finds the innermost package, scoped or not, and ignores own code and virtual modules", () => {
		const nm = `${sep}p${sep}node_modules${sep}`;
		assert.equal(packageRootOf(`${nm}@scope${sep}pkg${sep}dist${sep}index.js`), `${nm}@scope${sep}pkg`);
		assert.equal(packageRootOf(`${nm}ws${sep}lib${sep}x.js?commonjs-module`), `${nm}ws`);
		assert.equal(packageRootOf(`${nm}a${sep}node_modules${sep}b${sep}i.js`), `${nm}a${sep}node_modules${sep}b`);
		assert.equal(packageRootOf(`${sep}p${sep}src${sep}plugin.ts`), undefined);
		assert.equal(packageRootOf("\0commonjsHelpers.js"), undefined);
	});

	it("throws instead of shipping a notice that lacks a bundled package's licence", () => {
		const dir = mkdtempSync(join(tmpdir(), "notices-"));
		try {
			const pkg = join(dir, "node_modules", "no-licence");
			mkdirSync(pkg, { recursive: true });
			writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "no-licence", version: "1.0.0", license: "MIT" }));
			writeFileSync(join(pkg, "index.js"), "");
			assert.equal(findLicenceFile(pkg), undefined);
			assert.throws(() => collectPackages([join(pkg, "index.js")]), /no licence file in no-licence@1\.0\.0/);
			writeFileSync(join(pkg, "LICENSE"), "Copyright (c) Example\nPermission is hereby granted\n");
			const [found] = collectPackages([join(pkg, "index.js"), join(pkg, "package.json")]);
			assert.deepEqual(found && [found.name, found.version, found.license], ["no-licence", "1.0.0", "MIT"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders every package with its full licence text, deterministically", () => {
		const packages = [
			{ name: "b", version: "1.0.0", license: "MIT", licenceText: "TEXT B" },
			{ name: "a", version: "2.0.0", license: "0BSD", licenceText: "TEXT A" },
		];
		const text = renderThirdPartyNotices(packages);
		assert.ok(text.includes("a 2.0.0  -  0BSD") && text.includes("TEXT A") && text.includes("TEXT B"));
		assert.equal(text, renderThirdPartyNotices(packages));
		assert.match(text, /imgs\/icons\/LICENSE-lucide\.txt/);
	});
});

describe("vendored Property Inspector code", () => {
	const vendor = join(PLUGIN_DIR, "ui/vendor/sdpi-components.js");

	it("the verbatim licence header and the licence texts of sdpi-components and Lit are in the notices", () => {
		const header = readVendorHeader(vendor);
		assert.match(header, /sdpi-components v\d+\.\d+\.\d+, Copyright Corsair Memory Inc\./);
		const text = renderThirdPartyNotices([], header);
		assert.ok(text.includes(header.trim()), "header verbatim");
		assert.match(text, /sdpi-components {2}- {2}MIT/);
		assert.match(text, /Lit {2}- {2}BSD-3-Clause/);
		assert.match(text, /Copyright 2019 Google LLC/);
		assert.match(text, /Permission is hereby granted, free of charge/);
		assert.match(text, /Redistribution and use in source and binary forms/);
		assert.match(text, /UNVERIFIED/, "says what could not be verified");
	});

	it("throws when the file has no licence header", () => {
		const dir = mkdtempSync(join(tmpdir(), "vendor-"));
		try {
			writeFileSync(join(dir, "x.js"), "!function(){}();");
			assert.throws(() => readVendorHeader(join(dir, "x.js")), /no licence header/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("generated notice files", { skip: built ? false : "run `npm run build` first" }, () => {
	it("exist next to the bundle and LICENSE/NOTICE are copies of the repository's", () => {
		for (const name of NOTICE_FILES) assert.ok(existsSync(join(PLUGIN_DIR, name)), `${name} missing: run npm run build`);
		assert.equal(readFileSync(join(PLUGIN_DIR, "LICENSE"), "utf-8"), readFileSync(join(ROOT, "LICENSE"), "utf-8"));
		assert.equal(readFileSync(join(PLUGIN_DIR, "NOTICE"), "utf-8"), readFileSync(join(ROOT, "NOTICE"), "utf-8"));
	});

	it("THIRD-PARTY-NOTICES.txt carries the SDK's copyright and permission notice", () => {
		const text = readFileSync(join(PLUGIN_DIR, "THIRD-PARTY-NOTICES.txt"), "utf-8");
		assert.match(text, /@elgato\/streamdeck \d+\.\d+\.\d+ {2}- {2}MIT/);
		assert.match(text, /Permission is hereby granted, free of charge/);
		assert.match(text, /Copyright/);
	});

	it("THIRD-PARTY-NOTICES.txt carries the sdpi-components and Lit licence texts", () => {
		const text = readFileSync(join(PLUGIN_DIR, "THIRD-PARTY-NOTICES.txt"), "utf-8");
		assert.match(text, /sdpi-components {2}- {2}MIT/);
		assert.match(text, /Redistribution and use in source and binary forms/);
	});

	it("covers every dependency of the inlined SDK", () => {
		// The list is derived from the build's module list; this checks it is not empty or stale
		// by comparing against the SDK package.json dependencies that are known to be inlined.
		const text = readFileSync(join(PLUGIN_DIR, "THIRD-PARTY-NOTICES.txt"), "utf-8");
		const sdk = JSON.parse(readFileSync(join(ROOT, "node_modules/@elgato/streamdeck/package.json"), "utf-8")) as { dependencies: Record<string, string> };
		for (const dep of Object.keys(sdk.dependencies)) assert.ok(text.includes(`${dep} `), `${dep} is a dependency of the inlined SDK but has no notice`);
	});
});

function zipEntries(file: string): string[] {
	const unzip = spawnSync("unzip", ["-Z1", file], { encoding: "utf-8" });
	if (unzip.status === 0) return unzip.stdout.split("\n").filter(Boolean);
	const py = spawnSync("python3", ["-I", "-c", "import sys,zipfile;print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", file], { encoding: "utf-8" });
	assert.equal(py.status, 0, `neither unzip nor python3 could list ${file}: ${py.stderr}`);
	return py.stdout.split("\n").filter(Boolean);
}

describe("packed .streamDeckPlugin", { skip: !built ? "run `npm run build` first" : existsSync(CLI) ? false : "the streamdeck CLI is not installed (npm ci)" }, () => {
	it("contains LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt of the plugin", () => {
		const out = mkdtempSync(join(tmpdir(), "home-weather-pack-"));
		try {
			const copy = join(out, "src", PLUGIN_DIR_NAME);
			cpSync(PLUGIN_DIR, copy, { recursive: true });
			const dest = join(out, "dest");
			mkdirSync(dest);
			const pack = spawnSync(CLI, ["pack", copy, "--output", dest, "--force", "--no-update-check"], { cwd: ROOT, encoding: "utf-8", timeout: 120_000 });
			assert.equal(pack.status, 0, `pack failed:\n${pack.stdout}\n${pack.stderr}`);
			const packed = readdirSync(dest).filter((f) => f.endsWith(".streamDeckPlugin"));
			assert.equal(packed.length, 1, `expected one packed file in the temp dir, got ${packed.join(", ")}`);
			const entries = zipEntries(join(dest, packed[0]!));
			for (const name of NOTICE_FILES) assert.ok(entries.includes(`${PLUGIN_DIR_NAME}/${name}`), `${name} is not in the packed plugin:\n${entries.join("\n")}`);
			assert.ok(entries.includes(`${PLUGIN_DIR_NAME}/bin/plugin.js`));
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
		assert.deepEqual(readdirSync(ROOT).filter((f) => f.endsWith(".streamDeckPlugin")), [], "no packed file may be left in the repository");
	});
});

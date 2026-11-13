/**
 * Licence notices for the packed plugin. Plain ES module (not .ts) because rollup.config.mjs
 * imports it and rollup bundles its config without a TypeScript loader; tests import it too.
 *
 * Why: bin/plugin.js is one minified file that inlines @elgato/streamdeck (MIT) and whatever
 * it pulls in. MIT and BSD require the copyright and permission notice to accompany copies and
 * substantial portions, and terser drops the licence comments, so the notices are generated
 * from the modules rollup actually put into the bundle and shipped next to the bundle:
 *
 *   <plugin>.sdPlugin/LICENSE                 the plugin's own licence (copy of ./LICENSE)
 *   <plugin>.sdPlugin/NOTICE                  the plugin's notice (copy of ./NOTICE)
 *   <plugin>.sdPlugin/THIRD-PARTY-NOTICES.txt every npm package inlined into bin/plugin.js,
 *                                             with its licence text, the licence texts of
 *                                             sdpi-components (MIT) and Lit (BSD-3-Clause), which
 *                                             ship inside ui/vendor/sdpi-components.js, plus
 *                                             pointers to the other separate material
 *
 * Deterministic: sorted, no timestamps, so a rebuild changes nothing. Fails loudly (throws)
 * when an inlined package has no licence file, instead of shipping a notice that quietly
 * lacks one.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

/** Directory of the innermost npm package that contains `moduleId`, or undefined for own code. */
export function packageRootOf(moduleId) {
	const clean = moduleId.split("?")[0];
	if (clean.startsWith("\0")) return undefined;
	const marker = `${sep}node_modules${sep}`;
	const at = clean.lastIndexOf(marker);
	if (at === -1) return undefined;
	const rest = clean.slice(at + marker.length).split(sep);
	const depth = rest[0].startsWith("@") ? 2 : 1;
	if (rest.length < depth) return undefined;
	return clean.slice(0, at + marker.length) + rest.slice(0, depth).join(sep);
}

/** The licence file of a package directory (LICENSE, LICENCE, COPYING, with any extension), or undefined. */
export function findLicenceFile(dir) {
	const names = readdirSync(dir).filter((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n)).sort();
	return names.length > 0 ? join(dir, names[0]) : undefined;
}

/**
 * Describe each npm package that contributed a module. Sorted by name then version.
 * @param {Iterable<string>} moduleIds
 * @returns {{ name: string, version: string, license: string, licenceText: string }[]}
 */
export function collectPackages(moduleIds) {
	const dirs = new Set();
	for (const id of moduleIds) {
		const dir = packageRootOf(id);
		if (dir) dirs.add(dir);
	}
	const packages = [...dirs].map((dir) => {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
		const file = findLicenceFile(dir);
		if (!file) throw new Error(`no licence file in ${pkg.name}@${pkg.version} (${dir}); it is bundled, so its notice must ship`);
		const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "UNKNOWN";
		return { name: String(pkg.name), version: String(pkg.version), license, licenceText: readFileSync(file, "utf-8").trim() };
	});
	return packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * The leading licence comment of the vendored sdpi-components bundle, verbatim (the file is
 * minified; terser-style bundlers keep only this block). Throws when it is missing: the
 * attribution would then be a guess.
 * @param {string} file
 */
export function readVendorHeader(file) {
	const text = readFileSync(file, "utf-8");
	const header = /^\/\*\*!?[\s\S]*?\*\//.exec(text)?.[0];
	if (!header || !/@license/.test(header)) throw new Error(`no licence header at the top of ${file}`);
	return header;
}

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const BSD3_BODY = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

/**
 * Text of THIRD-PARTY-NOTICES.txt. `vendorHeader` is the verbatim licence comment of
 * ui/vendor/sdpi-components.js; given, it adds the licence texts of sdpi-components and Lit.
 * @param {{ name: string, version: string, license: string, licenceText: string }[]} packages
 * @param {string} [vendorHeader]
 */
export function renderThirdPartyNotices(packages, vendorHeader) {
	const bar = "=".repeat(78);
	const out = [
		"Third-party notices for the Home Weather Station plugin (unofficial Stream Deck plugin)",
		"",
		"1. npm packages inlined into bin/plugin.js",
		"   (generated from the module list of the build; the plugin's own licence is in LICENSE)",
		"",
	];
	if (packages.length === 0) out.push("   (none)", "");
	for (const p of packages) out.push(bar, `${p.name} ${p.version}  -  ${p.license}`, bar, "", p.licenceText, "");
	out.push(
		bar,
		"2. Material that ships as separate files",
		bar,
		"",
		"- Lucide icons (ISC; some derived from Feather, MIT): imgs/icons/LICENSE-lucide.txt",
		"- sdpi-components (MIT) and Lit (BSD-3-Clause), vendored for the Property Inspector in",
		"  ui/vendor/sdpi-components.js: their licence texts are in section 3; the version list is in",
		"  ui/vendor/VENDORED.md",
		"",
	);
	if (vendorHeader !== undefined) {
		out.push(
			bar,
			"3. sdpi-components and Lit (ui/vendor/sdpi-components.js)",
			bar,
			"",
			"The licence header at the top of that file, verbatim:",
			"",
			vendorHeader.trim(),
			"",
			"The file's own header names the copyright holders but not the licence texts. The licences",
			"(sdpi-components: MIT; Lit: BSD-3-Clause) are recorded in ui/vendor/VENDORED.md (Lit's also by",
			"the SPDX line of the header). The texts below are the standard texts of those licences with the",
			"copyright lines taken from the header; the upstream LICENSE files were not part of the",
			"vendored file, so whether they carry exactly the same copyright line is UNVERIFIED.",
			"",
			bar,
			"sdpi-components  -  MIT",
			bar,
			"",
			"Copyright Corsair Memory Inc. and other contributors",
			"",
			MIT_BODY,
			"",
			bar,
			"Lit  -  BSD-3-Clause",
			bar,
			"",
			"Copyright 2019 Google LLC",
			"",
			BSD3_BODY,
			"",
		);
	}
	return out.join("\n");
}

function writeIfChanged(path, content) {
	if (existsSync(path) && readFileSync(path, "utf-8") === content) return false;
	writeFileSync(path, content, "utf-8");
	return true;
}

/**
 * Rollup plugin: after the bundle is written, put LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt
 * into the .sdPlugin folder. `projectRoot` holds the plugin's LICENSE and NOTICE.
 */
export function noticesPlugin({ projectRoot, pluginDir }) {
	const vendorFile = join(pluginDir, "ui", "vendor", "sdpi-components.js");
	let moduleIds = [];
	return {
		name: "licence-notices",
		generateBundle(_options, bundle) {
			// Only modules that contributed code: a module tree-shaken to nothing is not "in" the bundle.
			moduleIds = Object.values(bundle).flatMap((chunk) =>
				chunk.type === "chunk" ? Object.entries(chunk.modules ?? {}).filter(([, m]) => m.renderedLength > 0).map(([id]) => id) : [],
			);
		},
		writeBundle() {
			const files = {
				"LICENSE": readFileSync(join(projectRoot, "LICENSE"), "utf-8"),
				"NOTICE": readFileSync(join(projectRoot, "NOTICE"), "utf-8"),
				"THIRD-PARTY-NOTICES.txt": renderThirdPartyNotices(collectPackages(moduleIds), readVendorHeader(vendorFile)),
			};
			for (const [name, content] of Object.entries(files)) writeIfChanged(join(pluginDir, name), content);
		},
	};
}

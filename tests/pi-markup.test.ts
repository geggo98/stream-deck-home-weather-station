/**
 * Structure checks for the two Property Inspector pages and their static assets.
 *
 * The pages are static HTML, so there is no compiler to catch an unclosed tag, a
 * setting key that the plugin never reads, or an inline handler that the Content
 * Security Policy would silently refuse. These tests parse the markup with a small
 * tokenizer (no DOM available) and keep those mistakes loud.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ui = join(root, "de.schwetschke.sd.home-weather-station.sdPlugin", "ui");
const PAGES = ["measurement.html", "dial.html", "focus.html", "auto-rotate.html", "info.html", "history.html", "navigation.html", "sensor-focus.html"] as const;

const VOID = new Set(["meta", "link", "input", "br", "hr", "img", "area", "base", "col", "source", "wbr"]);

interface Tag {
	readonly name: string;
	readonly closing: boolean;
	readonly attrs: Readonly<Record<string, string>>;
	readonly raw: string;
}

function read(file: string): string {
	return readFileSync(join(ui, file), "utf8");
}

/** Tokenise tags; comments and the doctype are dropped, quoted attribute values may hold ">". */
function tags(html: string): Tag[] {
	const out: Tag[] = [];
	const stripped = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/gi, "");
	const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
	for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
		const attrs: Record<string, string> = {};
		const attrRe = /([^\s=\/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
		const body = m[3] ?? "";
		for (let a = attrRe.exec(body); a; a = attrRe.exec(body)) {
			attrs[(a[1] ?? "").toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
		}
		out.push({ name: (m[2] ?? "").toLowerCase(), closing: m[1] === "/", attrs, raw: m[0] });
	}
	return out;
}

function assertBalanced(file: string, list: readonly Tag[]): void {
	const stack: string[] = [];
	for (const t of list) {
		if (VOID.has(t.name)) continue;
		if (t.raw.endsWith("/>")) continue;
		if (!t.closing) {
			stack.push(t.name);
			continue;
		}
		const top = stack.pop();
		assert.equal(top, t.name, `${file}: </${t.name}> closes <${top ?? "nothing"}>`);
	}
	assert.deepEqual(stack, [], `${file}: unclosed elements`);
}

/** Keys of `interface MeasurementSettings` in src/pi-protocol.ts. */
function measurementSettingsKeys(): string[] {
	const src = readFileSync(join(root, "src", "pi-protocol.ts"), "utf8");
	const body = /export interface MeasurementSettings \{([\s\S]*?)\n\}/.exec(src)?.[1];
	assert.ok(body, "interface MeasurementSettings not found in src/pi-protocol.ts");
	const keys = [...body.matchAll(/^\t(\w+)\??:/gm)].map((m) => m[1] as string);
	assert.ok(keys.length >= 5, `parsed too few keys (${keys.join(", ")}); the regex no longer sees the interface`);
	return keys;
}

function accountBlock(html: string): string {
	const m = /<section id="account">[\s\S]*?<\/section>/.exec(html);
	assert.ok(m, "no account section");
	return m[0].replace(/\s+/g, " ").replace(/> </g, "><").trim();
}

for (const page of PAGES) {
	test(`${page}: tags are balanced`, () => {
		const list = tags(read(page));
		assert.ok(list.length > 25, "tokenizer saw suspiciously few tags");
		assertBalanced(page, list);
	});

	test(`${page}: every setting key exists in MeasurementSettings`, () => {
		const known = new Set(measurementSettingsKeys());
		const used = tags(read(page))
			.filter((t) => "setting" in t.attrs)
			.map((t) => t.attrs.setting as string);
		// info.html and navigation.html have no setting at all; every other page binds at least one.
		if (page !== "info.html" && page !== "navigation.html") assert.ok(used.length >= 1, "found no setting bindings; the scan sees nothing");
		for (const key of used) assert.ok(known.has(key), `${page}: setting="${key}" is not a MeasurementSettings key`);
	});

	test(`${page}: no inline script, no inline handlers, no global bindings`, () => {
		const html = read(page);
		for (const t of tags(html)) {
			if (t.name === "script" && !t.closing) assert.ok(t.attrs.src, `${page}: inline <script> (CSP refuses it)`);
			for (const attr of Object.keys(t.attrs)) {
				assert.ok(!/^on\w+/.test(attr), `${page}: inline handler ${attr} on <${t.name}>`);
			}
			assert.ok(!("global" in t.attrs), `${page}: sdpi "global" binding on <${t.name}> (use sendToPlugin)`);
			assert.ok(!/^\s*javascript:/i.test(t.attrs.href ?? ""), `${page}: javascript: URL`);
		}
		// A script element with a body would also be inline.
		assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${page}: <script> without src`);
	});

	test(`${page}: strict CSP meta is present`, () => {
		const meta = tags(read(page)).find(
			(t) => t.name === "meta" && (t.attrs["http-equiv"] ?? "").toLowerCase() === "content-security-policy",
		);
		assert.ok(meta, `${page}: no CSP meta`);
		const csp = meta.attrs.content ?? "";
		assert.match(csp, /default-src 'none'/);
		assert.match(csp, /script-src 'self'(;|$)/);
		assert.ok(!/script-src[^;]*unsafe/.test(csp), "script-src must not allow unsafe-*");
		assert.match(csp, /style-src 'self' 'unsafe-inline'/);
		assert.match(csp, /img-src 'self' data:/);
		assert.match(csp, /connect-src ws:\/\/127\.0\.0\.1:\* ws:\/\/localhost:\*(;|$)/);
		assert.ok(!/https?:/.test(csp), "CSP must not allow remote hosts");
		// base-uri and form-action do not fall back to default-src.
		assert.match(csp, /(^|;)\s*base-uri 'none'(;|$)/);
		assert.match(csp, /(^|;)\s*form-action 'none'(;|$)/);
	});

	test(`${page}: no external URLs in attributes, only local scripts and styles that exist`, () => {
		const list = tags(read(page));
		for (const t of list) {
			for (const [name, value] of Object.entries(t.attrs)) {
				if (name === "content" && t.name === "meta") continue;
				assert.ok(!/^\s*(https?:)?\/\//i.test(value), `${page}: external URL in ${name}="${value}"`);
			}
		}
		const local = list.flatMap((t) => [t.attrs.src, t.name === "link" ? t.attrs.href : undefined]).filter((v): v is string => !!v);
		assert.ok(local.length >= 4);
		for (const p of local) assert.ok(existsSync(join(ui, p)), `${page}: references missing file ${p}`);
	});

	test(`${page}: sdpi script is in the head and loads first`, () => {
		const html = read(page);
		const head = /<head[\s\S]*?<\/head>/.exec(html)?.[0] ?? "";
		const scripts = [...head.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(scripts, ["vendor/sdpi-components.js", "home-weather-pi.js"]);
		// The page's own init script is the last thing in the body.
		assert.match(html, /<script src="init\/[a-z-]+\.js"><\/script>\s*<\/body>/);
	});

	test(`${page}: secret inputs are plain, masked and have no setting binding`, () => {
		const inputs = tags(read(page)).filter((t) => t.name === "input");
		const byId = new Map(inputs.map((t) => [t.attrs.id, t]));
		for (const id of ["clientSecret", "refreshToken"]) {
			const input = byId.get(id);
			assert.ok(input, `${page}: input #${id} missing`);
			assert.equal(input.attrs.type, "password");
			assert.ok(!("setting" in input.attrs), `${page}: #${id} must not be bound to a setting`);
			assert.ok(!("value" in input.attrs), `${page}: #${id} must not be prefilled`);
			assert.equal(input.attrs.autocomplete, "off");
		}
		const id = byId.get("clientId");
		assert.ok(id && !("setting" in id.attrs) && !("value" in id.attrs), `${page}: #clientId bound or prefilled`);
		// No sdpi-password either: it would offer a setting binding.
		assert.ok(!read(page).includes("<sdpi-password"));
	});

	test(`${page}: account block carries the required controls and notices`, () => {
		const block = accountBlock(read(page));
		for (const label of ["Save and test", "Clear", "Refresh now", "Sign in with browser"]) {
			assert.ok(block.includes(label), `${page}: missing button text "${label}"`);
		}
		assert.ok(block.includes("scope read_station"));
		for (const label of ["Update interval", "Default units"]) assert.ok(block.includes(`label="${label}"`), `${page}: missing ${label}`);
		for (const v of ["60", "300", "600", "1800", "3600"]) assert.ok(block.includes(`<option value="${v}"`), `${page}: poll option ${v}`);
		assert.match(block, /<option value="300" selected>5 min/);
		assert.ok(block.includes("about every 10 minutes"));
		assert.ok(!/<(select|input)[^>]*\bsetting=/.test(block), "account block controls must not carry a setting binding");
		assert.ok(block.includes("Everything you enter stays on this computer."));
		assert.ok(block.includes("Unofficial plugin, not affiliated with Netatmo, Elgato or Corsair."));
		assert.match(block, /<details id="browserLoginBox"[^>]*\bopen\b/, "the recommended browser sign-in must start open");
		assert.ok(block.includes("dev.netatmo.com"), "the help text must name the developer portal");
		assert.ok(block.includes("Recommended: register"), "the help text must lead with the recommended route");
		// Order: the browser sign-in comes before the paste route's token field and Save button.
		assert.ok(block.indexOf('id="startBrowserLogin"') < block.indexOf('id="refreshToken"'), "browser sign-in must come first");
		assert.ok(block.indexOf('id="refreshToken"') < block.indexOf('id="saveCredentials"'));
	});
}

test("every page carries a byte-identical account block (whitespace normalised)", () => {
	const blocks = PAGES.map((p) => accountBlock(read(p)));
	assert.ok(blocks[0] && blocks[0].length > 800, "account block suspiciously short");
	assert.equal(blocks.length, 8);
	for (const [i, b] of blocks.entries()) assert.equal(b, blocks[0], `${PAGES[i]} differs from ${PAGES[0]}`);
});

test("every HTML file in ui/ is in the page list (a new page cannot dodge the checks)", () => {
	assert.deepEqual(readdirSync(ui).filter((f) => f.endsWith(".html")).sort(), [...PAGES].sort());
});

test("measurement page offers module, metric, units, trend, min/max, big text and label", () => {
	const list = tags(read("measurement.html"));
	const settings = new Set(list.filter((t) => "setting" in t.attrs).map((t) => t.attrs.setting));
	for (const key of ["moduleKey", "metric", "unitSystem", "showTrend", "showMinMax", "bigText", "label"]) {
		assert.ok(settings.has(key), `measurement.html lacks ${key}`);
	}
	const sources = list.filter((t) => "datasource" in t.attrs);
	assert.deepEqual(sources.map((t) => t.attrs.datasource).sort(), ["getMetrics", "getModules"]);
	for (const t of sources) assert.ok("hot-reload" in t.attrs, `${t.attrs.datasource} must hot-reload`);
	assert.match(read("measurement.html"), /image text \(experimental\)/);
});

test("dial page has module, units and trend, and no metric dropdown", () => {
	const list = tags(read("dial.html"));
	const settings = new Set(list.filter((t) => "setting" in t.attrs).map((t) => t.attrs.setting));
	assert.deepEqual([...settings].sort(), ["followFocus", "moduleKey", "showTrend", "unitSystem"]);
	assert.ok(!list.some((t) => t.attrs.datasource === "getMetrics"), "the dial cycles metrics, it has no metric dropdown");
});

/** Settings bound on a page, with their tag. */
function bound(page: string): Map<string, Tag> {
	return new Map(tags(read(page)).filter((t) => "setting" in t.attrs).map((t) => [t.attrs.setting as string, t]));
}

test("every settings key in the new fields exists in MeasurementSettings (lists the ones the protocol still lacks)", () => {
	const known = new Set(measurementSettingsKeys());
	for (const key of ["followFocus", "alertAbove", "alertBelow", "historyWindow", "autoRotateSeconds", "autoRotateStartOn"]) {
		assert.ok(known.has(key), `MeasurementSettings lacks ${key}`);
	}
});

test("measurement page: followFocus checkbox and alert fields (empty = off, display-unit hint)", () => {
	const b = bound("measurement.html");
	assert.equal(b.get("followFocus")?.name, "sdpi-checkbox");
	for (const key of ["alertAbove", "alertBelow"]) {
		const t = b.get(key);
		assert.equal(t?.name, "sdpi-textfield", `${key} field`);
		assert.equal(t?.attrs.placeholder, "off");
		assert.ok(t?.attrs.pattern, `${key} must restrict input to numbers`);
		assert.ok(!("required" in (t?.attrs ?? {})), `${key} must be optional`);
	}
	const html = read("measurement.html");
	assert.match(html, /Leave empty to switch an alert off/);
	assert.match(html, /in the unit this key shows/);
});

test("measurement page: the alert fields stay visible for a following key (same metric, same unit) and the follow text promises what the plugin does", () => {
	const html = read("measurement.html");
	assert.ok(html.includes('setting="alertAbove"') && html.includes('setting="alertBelow"'), "both alert fields exist");
	assert.doesNotMatch(html, /alertFollowHint|Thresholds only apply to fixed keys/, "the hide-on-follow hint belonged to the old semantics");
	assert.doesNotMatch(readFileSync(join(ui, "init", "measurement.js"), "utf8"), /initAlertToggle/);
	assert.match(html.replace(/\s+/g, " "), /a CO2 key stays a CO2 key/, "the follow text says the key keeps its own value");
});

test("PI pages: no brand word in headings or section titles", () => {
	for (const page of PAGES) {
		const html = read(page);
		for (const m of html.matchAll(/<(h[1-6]|title)\b[^>]*>([^<]*)|class="pi-account-title">([^<]*)/g)) {
			assert.ok(!/netatmo|elgato|corsair/i.test(m[2] ?? m[3] ?? ""), `${page}: brand word in heading "${m[0]}"`);
		}
	}
});

test("dial page: followFocus defaults to on and the gesture legend names every gesture", () => {
	assert.equal(bound("dial.html").get("followFocus")?.attrs.default, "true");
	const text = read("dial.html").replace(/\s+/g, " ");
	for (const phrase of ["Rotate: next value", "Push: next sensor", "Push and rotate: next station", "Tap the touch strip: reload"]) {
		assert.ok(text.includes(phrase), `dial legend lacks "${phrase}"`);
	}
	// dial-controller.ts: value -> min/max (temperature only) -> 24 h mini history (where available) -> value
	assert.ok(
		text.includes("Long touch: cycles value &rarr; minimum and maximum (temperature only) &rarr; 24 h mini history (where available) &rarr; value."),
		"long-touch text must describe the real cycle",
	);
});

test("focus page: units, trend, min/max, no alert fields, no module or metric pickers, explains the navigation keys", () => {
	const b = bound("focus.html");
	assert.deepEqual([...b.keys()].sort(), ["showMinMax", "showTrend", "unitSystem"]);
	assert.equal(b.get("unitSystem")?.attrs.default, "auto");
	assert.ok(!tags(read("focus.html")).some((t) => "datasource" in t.attrs));
	const text = read("focus.html").replace(/\s+/g, " ");
	assert.match(text, /one number cannot fit every measurement. For thresholds use a measurement key/);
	for (const phrase of ["Reload", "Next / previous value", "Next / previous sensor", "Next / previous station", "cannot make the station measure"]) {
		assert.ok(text.includes(phrase), `focus page lacks "${phrase}"`);
	}
});

test("auto-rotate page: interval 3..60 (default 8) and start-on checkbox", () => {
	const b = bound("auto-rotate.html");
	assert.deepEqual([...b.keys()].sort(), ["autoRotateSeconds", "autoRotateStartOn"]);
	const r = b.get("autoRotateSeconds");
	assert.equal(r?.name, "sdpi-range");
	assert.equal(r?.attrs.min, "3");
	assert.equal(r?.attrs.max, "60");
	assert.equal(r?.attrs.default, "8");
	assert.equal(b.get("autoRotateStartOn")?.name, "sdpi-checkbox");
});

test("info page: explanation and account block only, no settings", () => {
	assert.equal(bound("info.html").size, 0);
	assert.match(read("info.html"), /battery/);
	assert.ok(!/radio|signal/i.test(read("info.html").replace(/<section id="account">[\s\S]*<\/section>/, "")), "info page promises a page that does not exist");
});

test("the three automatic-unit selects say what Automatic follows", () => {
	for (const page of ["measurement.html", "dial.html", "focus.html"]) {
		const html = read(page);
		assert.ok(html.includes('<option value="auto">Automatic (use Default units)</option>'), page);
		assert.ok(!html.includes("follow the account"), page);
	}
});

test("manual module key help: ids are MAC addresses with a documentation-range example", () => {
	for (const page of ["measurement.html", "dial.html", "history.html"]) {
		const text = read(page).replace(/\s+/g, " ");
		assert.ok(text.includes("MAC addresses"), page);
		assert.ok(text.includes("00:00:5e:00:53:01|00:00:5e:00:53:02"), page);
	}
	for (const page of ["measurement.html", "history.html"]) {
		assert.ok(read(page).replace(/\s+/g, " ").includes("the key picks a module that reports its measurement"), page);
	}
});

test("navigation page: explains every key, has the account block, no unit select, no settings", () => {
	assert.equal(bound("navigation.html").size, 0);
	const html = read("navigation.html");
	const outside = html.replace(/<section id="account">[\s\S]*<\/section>/, "").replace(/\s+/g, " ");
	for (const phrase of ["Next / previous value", "Next / previous sensor", "Next / previous station", "Reload", "at most once a minute", "cannot make the station measure"]) {
		assert.ok(outside.includes(phrase), `navigation page lacks "${phrase}"`);
	}
	assert.ok(!/unitSystem|label="Units"/.test(outside), "the navigation keys have no unit setting");
	assert.match(html, /<title>Navigation Settings<\/title>/);
});

test("history page: window 6h/24h/3d, followFocus default on, pickers inside #pinnedBlock", () => {
	const html = read("history.html");
	const b = bound("history.html");
	assert.deepEqual([...b.keys()].sort(), ["followFocus", "historyWindow", "metric", "moduleKey"]);
	assert.equal(b.get("followFocus")?.attrs.default, "true");
	for (const v of ["6h", "24h", "3d"]) assert.ok(html.includes(`<option value="${v}">`), `window option ${v}`);
	assert.equal(b.get("historyWindow")?.attrs.default, "24h");
	const block = /<div id="pinnedBlock">([\s\S]*?)\n\t<\/div>\n\n\t<div class="sdpi-divider"/.exec(html)?.[1] ?? "";
	assert.ok(block.length > 100, "pinnedBlock not found");
	assert.ok(block.includes('setting="moduleKey"') && block.includes('setting="metric"'));
	assert.ok(!block.includes('setting="followFocus"') && !block.includes('setting="historyWindow"'), "followFocus and the window stay outside the hidden block");
	const sources = tags(html).filter((t) => "datasource" in t.attrs).map((t) => t.attrs.datasource).sort();
	assert.deepEqual(sources, ["getMetrics", "getModules"]);
});

test("page init scripts exist for every page and name the right initialisers", () => {
	for (const [name, expected] of [
		["focus", ["initAccount"]],
		["auto-rotate", ["initAccount"]],
		["info", ["initAccount"]],
		["navigation", ["initAccount"]],
		["history", ["initModulePicker", "initFollowToggle", "initAccount"]],
		["sensor-focus", ["initModulePicker", "initAccount"]],
	] as const) {
		const js = readFileSync(join(ui, "init", `${name}.js`), "utf8");
		for (const fn of expected) assert.ok(js.includes(`HomeWeatherPI.${fn}()`), `${name}.js lacks ${fn}`);
	}
	for (const page of PAGES) {
		const m = /<script src="init\/([a-z-]+)\.js">/.exec(read(page));
		assert.equal(m?.[1], page.replace(".html", ""), `${page}: init script name`);
	}
});

test("select options always come from markup or a datasource, with auto as the unit default", () => {
	for (const page of PAGES) {
		const list = tags(read(page));
		if (!list.some((t) => t.attrs.setting === "unitSystem")) continue;
		const units = list.find((t) => t.attrs.setting === "unitSystem");
		assert.equal(units?.attrs.default, "auto");
		const html = read(page);
		for (const v of ["auto", "metric", "imperial"]) assert.ok(html.includes(`<option value="${v}">`), `${page}: option ${v}`);
	}
});

test("vendored sdpi-components matches the hash recorded in VENDORED.md", () => {
	const file = readFileSync(join(ui, "vendor", "sdpi-components.js"));
	const sha = createHash("sha256").update(file).digest("hex");
	const doc = readFileSync(join(ui, "vendor", "VENDORED.md"), "utf8");
	assert.ok(doc.includes(sha), `VENDORED.md does not list ${sha}`);
	assert.ok(doc.includes(`${file.length} bytes`), `VENDORED.md does not list the size ${file.length}`);
	assert.match(file.toString("utf8", 0, 400), /sdpi-components v4\.0\.1/);
});

test("PI sources (outside vendor/) hold no raw control bytes, personal data or real-looking identifiers", () => {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(join(ui, dir), { withFileTypes: true })) {
			const rel = dir ? `${dir}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (e.name !== "vendor") walk(rel);
			} else files.push(rel);
		}
	};
	walk("");
	files.push("vendor/VENDORED.md");
	assert.ok(files.length >= 7, `walked too few files: ${files.join(", ")}`);
	for (const f of files) {
		const text = read(f);
		assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), `${f}: raw control byte`);
		assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text), `${f}: e-mail address`);
		for (const mac of text.matchAll(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi)) {
			assert.ok(/^00:00:5e:00:53:/i.test(mac[0]), `${f}: MAC address outside the documentation range: ${mac[0]}`);
		}
		for (const ip of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
			assert.ok(/^(127\.0\.0\.1$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip[0]), `${f}: IP outside the RFC 5737 ranges: ${ip[0]}`);
		}
	}
});

test("brand rules: no logo or image references, no product branding in titles", () => {
	for (const page of PAGES) {
		const list = tags(read(page));
		assert.ok(!list.some((t) => t.name === "img" || t.name === "svg"), `${page}: image or svg element`);
		const title = /<title>([^<]*)<\/title>/.exec(read(page))?.[1] ?? "";
		assert.ok(title && !/netatmo|elgato|stream deck/i.test(title), `${page}: title "${title}"`);
	}
	for (const page of PAGES) {
		// The brand may appear in running text and the notice, not as a styled heading.
		for (const m of read(page).matchAll(/<(div|h[1-6]|summary|legend)\b[^>]*class="[^"]*(?:title|heading|hero)[^"]*"[^>]*>([^<]*)</g)) {
			assert.ok(!/netatmo|elgato|corsair/i.test(m[2] ?? ""), `${page}: brand in styled heading "${m[2]}"`);
		}
		for (const m of read(page).matchAll(/<sdpi-item\b[^>]*label="([^"]*)"/g)) {
			assert.ok(!/netatmo/i.test(m[1] ?? ""), `${page}: brand in label "${m[1]}"`);
		}
		assert.ok(read(page).includes('class="pi-account-title">Weather station account<'), `${page}: account heading`);
	}
	assert.ok(!/url\(/.test(read("home-weather-pi.css")), "the stylesheet loads no images or fonts");
});

test("sensor focus page: metric from getMetrics (no hot-reload), no module picker, no follow checkbox, alerts, label limit, own explanation", () => {
	const html = read("sensor-focus.html");
	const b = bound("sensor-focus.html");
	assert.deepEqual([...b.keys()].sort(), ["alertAbove", "alertBelow", "bigText", "label", "metric", "showMinMax", "showTrend", "unitSystem"]);
	assert.equal(b.get("metric")?.attrs.datasource, "getMetrics");
	assert.equal(b.get("metric")?.attrs.default, "temperature");
	assert.ok(!("hot-reload" in (b.get("metric")?.attrs ?? {})), "the metric list does not depend on a module");
	assert.deepEqual(tags(html).filter((t) => "datasource" in t.attrs).map((t) => t.attrs.datasource), ["getMetrics"]);
	assert.equal(b.get("unitSystem")?.attrs.default, "auto");
	for (const id of ["manualModuleBtn", "manualModuleKey", "moduleListHint"]) assert.ok(!html.includes(`id="${id}"`), `module picker element ${id} must not be on this page`);
	assert.ok(!html.includes("followFocus"), "this key always follows; no checkbox");
	for (const key of ["alertAbove", "alertBelow"]) assert.equal(b.get(key)?.attrs.placeholder, "off");
	assert.match(html, /image text \(experimental\)/);
	const text = html.replace(/\s+/g, " ");
	for (const phrase of [
		"always shows the sensor that the focus points at",
		"Next/Previous Sensor and Station keys and the dial",
		"the Next/Previous Value keys do not change it",
		"the key says No data",
	]) assert.ok(text.includes(phrase), `sensor focus page lacks "${phrase}"`);
	assert.match(html, /<title>Sensor Focus Settings<\/title>/);
});

test("focus page names the difference to the Sensor Focus key", () => {
	const text = read("focus.html").replace(/\s+/g, " ");
	assert.match(text, /<strong>Sensor Focus<\/strong> key is the sibling that follows the sensor only/);
	assert.match(text, /This Focus display follows sensor and value/);
});

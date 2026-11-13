/**
 * Behaviour of ui/home-weather-pi.js, run in a node:vm sandbox against a tiny fake DOM
 * and a fake sdpi client. The file is plain browser script (no module system), so the
 * sandbox provides `window` and nothing else.
 *
 * What this cannot show: how the real sdpi components and Stream Deck behave. That
 * needs the app (see the manual checklist in the integrator notes).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ui = join(root, "de.schwetschke.sd.home-weather-station.sdPlugin", "ui");

// Fictional values only (documentation MAC range).
const SECRET = "fake-secret-value-for-tests";
const TOKEN = "fake-id|fake-refresh-token-for-tests";
const CLIENT_ID = "fake-client-id";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

function load(): Any {
	const win: Any = {};
	vm.runInNewContext(readFileSync(join(ui, "home-weather-pi.js"), "utf8"), { window: win });
	return win.HomeWeatherPI;
}

/** Objects built inside the sandbox have another realm's prototypes; compare as plain JSON. */
function plain<T = Any>(value: unknown): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

interface FakeEl {
	id: string;
	value: string;
	textContent: string;
	className: string;
	disabled: boolean;
	open: boolean;
	style: Record<string, string>;
	focused: boolean;
	refreshed: number;
	addEventListener(type: string, fn: () => void): void;
	dispatch(type: string): void;
	focus(): void;
	refresh(): void;
}

function fakeEl(id: string): FakeEl {
	const listeners: Record<string, Array<() => void>> = {};
	return {
		id,
		value: "",
		textContent: "",
		className: "",
		disabled: false,
		open: false,
		style: {},
		focused: false,
		refreshed: 0,
		addEventListener(type, fn) {
			(listeners[type] ??= []).push(fn);
		},
		dispatch(type) {
			for (const fn of listeners[type] ?? []) fn();
		},
		focus() {
			this.focused = true;
		},
		refresh() {
			this.refreshed += 1;
		},
	};
}

function fakeTimers() {
	let next = 1;
	let pending: Array<{ id: number; fn: () => void; ms: number }> = [];
	return {
		setTimeout(fn: () => void, ms: number): number {
			const id = next++;
			pending.push({ id, fn, ms });
			return id;
		},
		clearTimeout(id: number): void {
			pending = pending.filter((t) => t.id !== id);
		},
		/** Run every timer that is due within `ms`, in order of delay. */
		advance(ms: number): void {
			const due = pending.filter((t) => t.ms <= ms).sort((a, b) => a.ms - b.ms);
			pending = pending.filter((t) => t.ms > ms);
			for (const t of due) t.fn();
		},
		get count(): number {
			return pending.length;
		},
	};
}

function fakeClient() {
	const sent: Any[] = [];
	const handlers: Array<(m: Any) => void> = [];
	return {
		sent,
		send(payload: Any) {
			sent.push(JSON.parse(JSON.stringify(payload)));
		},
		subscribe(fn: (m: Any) => void) {
			handlers.push(fn);
		},
		deliver(message: Any) {
			for (const h of handlers) h(message);
		},
	};
}

const ACCOUNT_IDS = [
	"accountStatus",
	"accountResult",
	"clientId",
	"clientSecret",
	"refreshToken",
	"saveCredentials",
	"clearCredentials",
	"refreshNow",
	"startBrowserLogin",
	"browserLoginBox",
	"browserLoginResult",
	"redirectUri",
	"pollInterval",
	"globalUnits",
];

function accountFixture(withClient = true) {
	const els = new Map<string, FakeEl>(ACCOUNT_IDS.map((id) => [id, fakeEl(id)]));
	const doc = { getElementById: (id: string) => els.get(id) ?? null, querySelector: () => null };
	const client = fakeClient();
	const timers = fakeTimers();
	const pi = load();
	pi.initAccount({ doc, client: withClient ? client : null, timers, formatTime: () => "12:34" });
	const el = (id: string): FakeEl => els.get(id) as FakeEl;
	return { pi, el, els, client, timers };
}

function fill(el: (id: string) => FakeEl): void {
	el("clientId").value = `  ${CLIENT_ID} `;
	el("clientSecret").value = SECRET;
	el("refreshToken").value = TOKEN;
}

/* ---------------- event names stay in sync with the protocol ---------------- */

function protocolEvents(): Record<string, string> {
	const src = readFileSync(join(root, "src", "pi-protocol.ts"), "utf8");
	const block = /export const PI_EVENTS = \{([\s\S]*?)\} as const;/.exec(src)?.[1] ?? "";
	const out: Record<string, string> = {};
	for (const m of block.matchAll(/^\t(\w+): "(\w+)",/gm)) out[m[1] as string] = m[2] as string;
	assert.ok(Object.keys(out).length >= 10, "parsed too few PI_EVENTS; the regex no longer sees the object");
	return out;
}

function interfaceKeys(name: string): string[] {
	const src = readFileSync(join(root, "src", "pi-protocol.ts"), "utf8");
	const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1] ?? "";
	return [...body.matchAll(/^\t(?:readonly )?(\w+)\??:/gm)].map((m) => m[1] as string);
}

test("EVENTS in the helper file equal PI_EVENTS in src/pi-protocol.ts", () => {
	assert.deepEqual(plain(load().EVENTS), protocolEvents());
});

test("sent messages have exactly the fields the protocol declares", () => {
	const pi = load();
	const creds = pi.buildCredentialsMessage({ clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: TOKEN });
	assert.deepEqual(Object.keys(creds.message).sort(), interfaceKeys("SetCredentialsMessage").sort());
	const login = pi.buildBrowserLoginMessage({ clientId: CLIENT_ID, clientSecret: SECRET });
	assert.deepEqual(Object.keys(login.message).sort(), interfaceKeys("StartBrowserLoginMessage").sort());
});

test("the global-settings events and message fields match the protocol", () => {
	const ev = protocolEvents();
	for (const name of ["getGlobalSettings", "setGlobalSettings", "globalSettings"]) assert.equal(ev[name], name);
	assert.deepEqual(interfaceKeys("SetGlobalSettingsMessage").sort(), ["event", "pollIntervalSeconds", "unitSystem"]);
	assert.deepEqual(interfaceKeys("GlobalSettingsMessage").sort(), ["event", "pollIntervalSeconds", "unitSystem"]);
});

test("label maxlength in both pages equals MAX_LABEL_CHARS in src/render/title.ts (cannot drift)", () => {
	const limit = Number(/export const MAX_LABEL_CHARS = (\d+);/.exec(readFileSync(join(root, "src", "render", "title.ts"), "utf8"))?.[1]);
	assert.ok(Number.isInteger(limit) && limit > 0, "constant not found; the regex no longer sees it");
	const html = readFileSync(join(ui, "measurement.html"), "utf8");
	const m = /<sdpi-textfield[^>]*setting="label"[^>]*>/.exec(html)?.[0] ?? "";
	assert.ok(m, "label textfield not found");
	assert.equal(Number(/maxlength="(\d+)"/.exec(m)?.[1]), limit);
});

function piScripts(): Array<{ file: string; text: string }> {
	const out: Array<{ file: string; text: string }> = [];
	for (const f of ["home-weather-pi.js", ...readdirSync(join(ui, "init")).map((n) => `init/${n}`)]) {
		out.push({ file: f, text: readFileSync(join(ui, f), "utf8") });
	}
	return out;
}

test("every PI_EVENTS name appears as a string literal in the PI scripts, none is misspelled", () => {
	const all = piScripts().map((s) => s.text).join("\n");
	for (const name of Object.values(protocolEvents())) {
		assert.ok(all.includes(`"${name}"`), `no string literal "${name}" in the PI scripts`);
	}
	// Every `event: ...` the PI sends or routes on is a known event name.
	const known = new Set(Object.values(protocolEvents()));
	for (const m of all.matchAll(/event:\s*"(\w+)"/g)) {
		assert.ok(known.has(m[1] as string), `unknown event literal "${m[1]}"`);
	}
});

test("PI scripts: no logging, no dynamic markup, no network, no storage of secrets", () => {
	const scripts = piScripts();
	assert.ok(scripts.length >= 3);
	for (const { file, text } of scripts) {
		assert.ok(!/\bconsole\s*\./.test(text), `${file}: console call (settings and messages may carry secrets)`);
		assert.ok(!/\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/.test(text), `${file}: builds markup from strings`);
		assert.ok(!/\beval\s*\(|new Function|\bfetch\s*\(|XMLHttpRequest|WebSocket|importScripts/.test(text), `${file}: network or dynamic code`);
		assert.ok(!/localStorage|sessionStorage|indexedDB|setSettings|\\.setGlobalSettings\\b|\\bglobal=/.test(text), `${file}: persists something`);
		for (const line of text.split("\n")) {
			if (/clientSecret|refreshToken/.test(line)) {
				assert.ok(!/\b(?:log|print|alert|debug|warn|error|info|trace)\s*\(/i.test(line.replace(/\/\/.*$/, "")), `${file}: secret name near a log-like call: ${line.trim()}`);
			}
		}
	}
});

/* ---------------- pure functions ---------------- */

test("describeStatus maps every state to text and class", () => {
	const pi = load();
	const d = (s: Any) => plain(pi.describeStatus(s, () => "12:34"));
	assert.equal(d(undefined).cls, "pi-status-unknown");
	assert.equal(d({ state: "bogus" }).cls, "pi-status-unknown");
	assert.deepEqual(d({ state: "not-configured" }).cls, "pi-status-warn");
	assert.equal(d({ state: "loading" }).text, "Connecting…");
	assert.deepEqual(d({ state: "ok", stationCount: 1, moduleCount: 3, lastUpdate: "2026-01-01T12:34:00Z", clientIdHint: "ab12" }), {
		text: "Connected: 1 station, 3 modules, updated 12:34, app ending ab12",
		cls: "pi-status-ok",
	});
	assert.equal(d({ state: "ok" }).text, "Connected");
	assert.equal(d({ state: "error", message: "timeout" }).text, "Temporary problem: timeout");
	assert.equal(d({ state: "error", message: "timeout" }).cls, "pi-status-warn");
	assert.equal(d({ state: "auth-error", message: "token rejected" }).cls, "pi-status-error");
	assert.match(d({ state: "auth-error" }).text, /^Sign-in needed/);
});

test("describeStatus clips long plugin text", () => {
	const pi = load();
	const text = plain(pi.describeStatus({ state: "error", message: "x".repeat(5000) })).text as string;
	assert.ok(text.length < 300);
});

test("buildCredentialsMessage trims, validates and never echoes values", () => {
	const pi = load();
	const ok = plain(pi.buildCredentialsMessage({ clientId: ` ${CLIENT_ID} `, clientSecret: SECRET, refreshToken: TOKEN }));
	assert.deepEqual(ok, { ok: true, message: { event: "setCredentials", clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: TOKEN } });

	const missing = plain(pi.buildCredentialsMessage({ clientId: "", clientSecret: "  ", refreshToken: TOKEN }));
	assert.equal(missing.ok, false);
	assert.match(missing.error, /Client ID, Client secret/);

	const spaced = plain(pi.buildCredentialsMessage({ clientId: CLIENT_ID, clientSecret: "two words", refreshToken: TOKEN }));
	assert.equal(spaced.ok, false);
	assert.ok(!spaced.error.includes("two words"));
	assert.equal(plain(pi.buildCredentialsMessage({ clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: `${TOKEN}\n${TOKEN}` })).ok, false);
	assert.equal(plain(pi.buildCredentialsMessage({ clientId: CLIENT_ID, clientSecret: "x".repeat(5000), refreshToken: TOKEN })).ok, false);
	assert.equal(plain(pi.buildCredentialsMessage(undefined)).ok, false);
});

test("buildBrowserLoginMessage needs id and secret only", () => {
	const pi = load();
	assert.deepEqual(plain(pi.buildBrowserLoginMessage({ clientId: CLIENT_ID, clientSecret: SECRET })), {
		ok: true,
		message: { event: "startBrowserLogin", clientId: CLIENT_ID, clientSecret: SECRET },
	});
	assert.equal(plain(pi.buildBrowserLoginMessage({ clientId: CLIENT_ID, clientSecret: "" })).ok, false);
});

test("parseModuleKey accepts empty and 'station|module', rejects the rest", () => {
	const pi = load();
	const p = (s: unknown) => plain(pi.parseModuleKey(s));
	assert.deepEqual(p(""), { valid: true, empty: true });
	assert.deepEqual(p("  "), { valid: true, empty: true });
	assert.deepEqual(p(" 00:00:5e:00:53:01|00:00:5e:00:53:02 "), {
		valid: true,
		empty: false,
		station: "00:00:5e:00:53:01",
		module: "00:00:5e:00:53:02",
	});
	for (const bad of ["abc", "a|", "|b", "a|b|c", "a b|c", "a|b c"]) assert.equal(p(bad).valid, false, bad);
});

test("countSelectable counts enabled leaves with a value, also in groups", () => {
	const pi = load();
	assert.equal(pi.countSelectable(undefined), 0);
	assert.equal(pi.countSelectable([]), 0);
	assert.equal(pi.countSelectable([{ label: "None", value: "", disabled: true }]), 0);
	assert.equal(pi.countSelectable([{ label: "Off", value: "x", disabled: true }]), 0);
	assert.equal(
		pi.countSelectable([
			{ label: "Test Station", children: [{ label: "Indoor", value: "s|m" }, { label: "Gone", value: "s|n", disabled: true }] },
			{ label: "Other", value: "o" },
		]),
		2,
	);
});

test("describeDatasourceReply explains an empty list by account state", () => {
	const pi = load();
	const d = (m: Any) => plain(pi.describeDatasourceReply(m));
	assert.equal(d({ items: [{ label: "A", value: "a" }] }).kind, "ok");
	assert.equal(d({ items: [], status: { state: "not-configured" } }).kind, "needs-account");
	assert.equal(d({ items: [], status: { state: "auth-error" } }).kind, "needs-account");
	assert.equal(d({ items: [], status: { state: "error" } }).kind, "problem");
	assert.equal(d({ items: [], status: { state: "ok" } }).kind, "empty");
	assert.equal(d({}).kind, "empty");
	assert.equal(d(null).kind, "empty");
});

test("payloadOf and statusOf accept both message shapes", () => {
	const pi = load();
	assert.deepEqual(plain(pi.payloadOf({ payload: { event: "x" } })), { event: "x" });
	assert.deepEqual(plain(pi.payloadOf({ event: "x" })), { event: "x" });
	assert.equal(pi.payloadOf(null), null);
	assert.deepEqual(plain(pi.statusOf({ event: "accountStatus", state: "ok" })).state, "ok");
	assert.deepEqual(plain(pi.statusOf({ event: "credentialsResult", status: { state: "error" } })).state, "error");
	assert.equal(pi.statusOf({ event: "x" }), undefined);
});

/* ---------------- account block behaviour ---------------- */

test("account: asks for the status on load and shows the plugin's answer", () => {
	const { client, el } = accountFixture();
	assert.deepEqual(client.sent, [{ event: "getAccountStatus" }, { event: "getGlobalSettings" }]);
	client.deliver({ event: "accountStatus", state: "ok", stationCount: 1, moduleCount: 2 });
	assert.equal(el("accountStatus").textContent, "Connected: 1 station, 2 modules");
	assert.equal(el("accountStatus").className, "pi-status pi-status-ok");
	client.deliver({ event: "accountStatus", status: { state: "auth-error", message: "token rejected" } });
	assert.equal(el("accountStatus").className, "pi-status pi-status-error");
});

test("account: says so when the plugin never answers, and not when it did", () => {
	const silent = accountFixture();
	silent.timers.advance(10_000);
	assert.match(silent.el("accountStatus").textContent, /No answer from the plugin/);
	assert.equal(silent.el("accountStatus").className, "pi-status pi-status-error");

	const answered = accountFixture();
	answered.client.deliver({ event: "accountStatus", state: "not-configured" });
	answered.timers.advance(10_000);
	assert.match(answered.el("accountStatus").textContent, /Not set up yet/);
});

test("account: Save sends the secrets once and empties every input at once", () => {
	const { client, el, els } = accountFixture();
	fill(el);
	el("saveCredentials").dispatch("click");

	const sends = client.sent.filter((m) => m.event === "setCredentials");
	assert.equal(sends.length, 1);
	assert.deepEqual(sends[0], { event: "setCredentials", clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: TOKEN });
	for (const id of ["clientId", "clientSecret", "refreshToken"]) assert.equal(el(id).value, "", `${id} not cleared`);
	assert.equal(el("saveCredentials").disabled, true, "double submit must be blocked while waiting");
	// Nothing rendered back.
	for (const e of els.values()) {
		assert.ok(!e.textContent.includes(SECRET) && !e.textContent.includes(TOKEN), `#${e.id} shows a secret`);
	}
});

test("account: a failed validation sends nothing and keeps what was typed", () => {
	const { client, el } = accountFixture();
	el("clientId").value = CLIENT_ID;
	el("clientSecret").value = SECRET;
	el("saveCredentials").dispatch("click");
	assert.equal(client.sent.filter((m) => m.event === "setCredentials").length, 0);
	assert.match(el("accountResult").textContent, /Refresh token/);
	assert.equal(el("accountResult").className, "pi-warn");
	assert.equal(el("clientSecret").value, SECRET);
	assert.ok(!el("accountResult").textContent.includes(SECRET));
});

test("account: credentialsResult updates status and re-enables Save; the error never shows secrets", () => {
	const { client, el, els } = accountFixture();
	fill(el);
	el("saveCredentials").dispatch("click");
	client.deliver({ event: "credentialsResult", ok: true, status: { state: "ok", stationCount: 1 } });
	assert.equal(el("saveCredentials").disabled, false);
	assert.match(el("accountResult").textContent, /^Saved/);
	assert.equal(el("accountStatus").className, "pi-status pi-status-ok");

	fill(el);
	el("saveCredentials").dispatch("click");
	client.deliver({ event: "credentialsResult", ok: false, error: "invalid_grant", status: { state: "auth-error" } });
	assert.equal(el("accountResult").className, "pi-warn");
	assert.match(el("accountResult").textContent, /^Not saved: invalid_grant/);
	for (const e of els.values()) assert.ok(!e.textContent.includes(SECRET), `#${e.id} shows a secret`);
});

test("account: saved:true with ok:false says saved, keeps polling, and does not ask for re-entry (fails with the old 'Not saved' text)", () => {
	const { client, el } = accountFixture();
	fill(el);
	el("saveCredentials").dispatch("click");
	client.deliver({ event: "credentialsResult", ok: false, saved: true, error: "Signed in, but loading station data failed.", status: { state: "error" } });
	const text = el("accountResult").textContent;
	assert.match(text, /^Saved, but station data could not be loaded yet: Signed in/);
	assert.match(text, /Polling retries by itself\.$/);
	assert.ok(!/enter the values again|Not saved/i.test(text));
	assert.equal(el("clientSecret").value, "");
	assert.equal(el("refreshToken").value, "");
	assert.equal(el("saveCredentials").disabled, false);
});

test("account: plugin-wide settings are requested, shown, and sent on change", () => {
	const { client, el } = accountFixture();
	assert.ok(client.sent.some((m) => m.event === "getGlobalSettings"));
	client.deliver({ event: "globalSettings", pollIntervalSeconds: 600, unitSystem: "imperial" });
	assert.equal(el("pollInterval").value, "600");
	assert.equal(el("globalUnits").value, "imperial");
	el("pollInterval").value = "60";
	el("pollInterval").dispatch("change");
	el("globalUnits").value = "metric";
	el("globalUnits").dispatch("change");
	assert.deepEqual(client.sent.filter((m) => m.event === "setGlobalSettings"), [
		{ event: "setGlobalSettings", pollIntervalSeconds: 60 },
		{ event: "setGlobalSettings", unitSystem: "metric" },
	]);
	// a value outside the five offered ones is never sent from the units select
	el("globalUnits").value = "bogus";
	el("globalUnits").dispatch("change");
	assert.equal(client.sent.filter((m) => m.event === "setGlobalSettings").length, 2);
});

test("account: a save that is never answered re-enables the button after a timeout", () => {
	const { el, timers } = accountFixture();
	fill(el);
	el("saveCredentials").dispatch("click");
	assert.equal(el("saveCredentials").disabled, true);
	timers.advance(60_000);
	assert.equal(el("saveCredentials").disabled, false);
});

test("account: Clear needs a second click and then sends clearCredentials once", () => {
	const { client, el, timers } = accountFixture();
	const clears = () => client.sent.filter((m) => m.event === "clearCredentials").length;
	el("clearCredentials").dispatch("click");
	assert.equal(clears(), 0);
	assert.equal(el("clearCredentials").textContent, "Click again to clear");
	el("clearCredentials").dispatch("click");
	assert.equal(clears(), 1);
	assert.equal(el("clearCredentials").textContent, "Clear");

	// The armed state expires on its own.
	el("clearCredentials").dispatch("click");
	timers.advance(10_000);
	assert.equal(el("clearCredentials").textContent, "Clear");
	el("clearCredentials").dispatch("click");
	assert.equal(clears(), 1, "after expiry the next click arms again instead of clearing");
});

test("account: Refresh now sends refreshNow and re-reads the status later", () => {
	const { client, el, timers } = accountFixture();
	el("refreshNow").dispatch("click");
	assert.equal(client.sent.filter((m) => m.event === "refreshNow").length, 1);
	timers.advance(5000);
	assert.equal(client.sent.filter((m) => m.event === "getAccountStatus").length, 2);
});

test("account: browser sign-in sends id and secret, wipes the secret, keeps the id, shows the redirect URI", () => {
	const { client, el } = accountFixture();
	el("clientId").value = CLIENT_ID;
	el("clientSecret").value = SECRET;
	el("startBrowserLogin").dispatch("click");
	const sends = client.sent.filter((m) => m.event === "startBrowserLogin");
	assert.deepEqual(sends, [{ event: "startBrowserLogin", clientId: CLIENT_ID, clientSecret: SECRET }]);
	assert.equal(el("clientSecret").value, "");
	assert.equal(el("clientId").value, CLIENT_ID);

	client.deliver({ event: "browserLogin", phase: "waiting", redirectUri: "http://localhost:12345/callback" });
	assert.equal(el("browserLoginBox").open, true);
	assert.equal(el("redirectUri").textContent, "http://localhost:12345/callback");
	assert.match(el("browserLoginResult").textContent, /Waiting/);

	client.deliver({ event: "browserLogin", phase: "done", status: { state: "ok" } });
	assert.equal(el("accountStatus").className, "pi-status pi-status-ok");
	client.deliver({ event: "browserLogin", phase: "error", message: "denied" });
	assert.equal(el("browserLoginResult").className, "pi-warn");
	assert.equal(el("browserLoginResult").textContent, "denied");
});

test("account: without an sdpi client everything is disabled and says why", () => {
	const { el } = accountFixture(false);
	for (const id of ["saveCredentials", "clearCredentials", "refreshNow", "startBrowserLogin"]) assert.equal(el(id).disabled, true);
	assert.match(el("accountStatus").textContent, /not available/);
});

test("account: text from the plugin is never treated as markup (textContent only)", () => {
	const { client, el } = accountFixture();
	client.deliver({ event: "accountStatus", state: "error", message: "<img src=x onerror=alert(1)>" });
	assert.ok(el("accountStatus").textContent.includes("<img"), "the text is shown literally");
});

/* ---------------- module picker ---------------- */

function pickerFixture(withMetric = true) {
	const ids = ["manualModuleItem", "manualModuleKey", "manualModuleBtn", "manualModuleHint", "moduleListHint"];
	const els = new Map<string, FakeEl>(ids.map((id) => [id, fakeEl(id)]));
	const moduleSelect = fakeEl("moduleSelect");
	const metricSelect = fakeEl("metricSelect");
	els.get("manualModuleItem")!.style.display = "none";
	const doc = {
		getElementById: (id: string) => els.get(id) ?? null,
		querySelector: (sel: string) => (sel.includes("moduleKey") ? moduleSelect : sel.includes("metric") && withMetric ? metricSelect : null),
	};
	const client = fakeClient();
	const timers = fakeTimers();
	load().initModulePicker({ doc, client, timers });
	return { el: (id: string) => els.get(id) as FakeEl, moduleSelect, metricSelect, client, timers };
}

test("picker: the manual field is hidden at first and the button reveals and focuses it", () => {
	const { el } = pickerFixture();
	assert.equal(el("manualModuleItem").style.display, "none");
	el("manualModuleBtn").dispatch("click");
	assert.equal(el("manualModuleItem").style.display, "");
	assert.equal(el("manualModuleKey").focused, true);
});

test("picker: no reply from the plugin reveals the manual field after the timeout", () => {
	const { el, timers } = pickerFixture();
	timers.advance(10_000);
	assert.match(el("moduleListHint").textContent, /No module list from the plugin/);
	assert.equal(el("moduleListHint").className, "pi-warn");
	assert.equal(el("manualModuleItem").style.display, "");
});

test("picker: a good list keeps the manual field hidden and silences the watchdog", () => {
	const { el, client, timers } = pickerFixture();
	client.deliver({ event: "getModules", items: [{ label: "Indoor", value: "s|m" }] });
	timers.advance(10_000);
	assert.equal(el("moduleListHint").textContent, "");
	assert.equal(el("manualModuleItem").style.display, "none");
});

test("picker: an empty list with an unconfigured account explains it and offers the manual field", () => {
	const { el, client } = pickerFixture();
	client.deliver({ event: "getModules", items: [], status: { state: "not-configured" } });
	assert.match(el("moduleListHint").textContent, /No account is set up/);
	assert.equal(el("manualModuleItem").style.display, "");
});

test("picker: metric replies are not mistaken for module replies", () => {
	const { el, client } = pickerFixture();
	client.deliver({ event: "getMetrics", items: [] });
	assert.equal(el("moduleListHint").textContent, "");
});

test("picker: a bad manual key is flagged, a good or empty one is not", () => {
	const { el } = pickerFixture();
	const field = el("manualModuleKey");
	field.value = "just-one-part";
	field.dispatch("input");
	assert.equal(el("manualModuleHint").className, "pi-warn");
	assert.match(el("manualModuleHint").textContent, /station id/);
	field.value = "00:00:5e:00:53:01|00:00:5e:00:53:02";
	field.dispatch("input");
	assert.equal(el("manualModuleHint").textContent, "");
	assert.equal(el("manualModuleHint").className, "pi-hint pi-hidden");
});

test("picker: changing the module refreshes the metric list once, after a short delay", () => {
	const { moduleSelect, metricSelect, timers } = pickerFixture();
	moduleSelect.dispatch("valuechange");
	moduleSelect.dispatch("valuechange");
	assert.equal(metricSelect.refreshed, 0);
	timers.advance(1000);
	assert.equal(metricSelect.refreshed, 1);
});

test("picker: the dial page (no metric dropdown) works without one", () => {
	const { moduleSelect, timers } = pickerFixture(false);
	moduleSelect.dispatch("valuechange");
	timers.advance(1000);
});

/* ---------------- metric default and follow toggle ---------------- */

test("pickDefault accepts only a non-empty string defaultValue", () => {
	const pi = load();
	assert.equal(pi.pickDefault({ event: "getMetrics", items: [], defaultValue: "temperature" }), "temperature");
	for (const bad of [{}, { defaultValue: 3 }, { defaultValue: "" }, null, undefined]) assert.equal(pi.pickDefault(bad), "");
});

test("picker: a getMetrics defaultValue preselects the metric while the setting is unset", () => {
	const { metricSelect, client } = pickerFixture();
	client.deliver({ event: "getMetrics", items: [{ label: "Temperature", value: "temperature" }], defaultValue: "temperature" });
	assert.equal((metricSelect as Any).default, "temperature");
});

test("picker: a stored metric is not overridden by defaultValue, and getModules replies do not set it", () => {
	const { metricSelect, client } = pickerFixture();
	metricSelect.value = "co2";
	client.deliver({ event: "getMetrics", items: [], defaultValue: "temperature" });
	assert.equal((metricSelect as Any).default, undefined);
	metricSelect.value = "";
	client.deliver({ event: "getModules", items: [], defaultValue: "temperature" });
	assert.equal((metricSelect as Any).default, undefined);
});

function followFixture(present = true) {
	const box = fakeEl("follow") as FakeEl & { value: Any };
	const block = fakeEl("pinnedBlock");
	block.style.display = "";
	const doc = {
		getElementById: (id: string) => (id === "pinnedBlock" && present ? block : null),
		querySelector: (sel: string) => (sel.includes("followFocus") ? box : null),
	};
	const timers = fakeTimers();
	load().initFollowToggle({ doc, client: null, timers });
	return { box, block, timers };
}

test("follow toggle: hidden while following (also when unset), shown when cleared, tracks changes", () => {
	const { box, block, timers } = followFixture();
	assert.equal(block.style.display, "none", "unset counts as following");
	box.value = false;
	box.dispatch("valuechange");
	assert.equal(block.style.display, "");
	box.value = true;
	box.dispatch("valuechange");
	assert.equal(block.style.display, "none");
	// The stored value arrives a moment after load.
	box.value = false;
	timers.advance(3000);
	assert.equal(block.style.display, "");
});

test("follow toggle: pages without the block or the checkbox do not throw", () => {
	followFixture(false);
});

function alertFixture(initial: Any) {
	const box = fakeEl("follow") as FakeEl & { value: Any };
	box.value = initial;
	const block = fakeEl("alertBlock");
	block.style.display = "";
	const hint = { classList: { cls: new Set(["pi-hidden"]), add(c: string) { this.cls.add(c); }, remove(c: string) { this.cls.delete(c); } } };
	const doc = {
		getElementById: (id: string) => (id === "alertBlock" ? block : id === "alertFollowHint" ? hint : null),
		querySelector: (sel: string) => (sel.includes("followFocus") ? box : null),
	};
	const timers = fakeTimers();
	load().initAlertToggle({ doc, client: null, timers });
	return { box, block, hint };
}

test("alert toggle: fields hidden and hint shown only while follow focus is ticked (unset = fixed key)", () => {
	const unset = alertFixture(undefined);
	assert.equal(unset.block.style.display, "");
	assert.ok(unset.hint.classList.cls.has("pi-hidden"));
	const { box, block, hint } = alertFixture(true);
	assert.equal(block.style.display, "none");
	assert.ok(!hint.classList.cls.has("pi-hidden"));
	box.value = false;
	box.dispatch("valuechange");
	assert.equal(block.style.display, "");
	assert.ok(hint.classList.cls.has("pi-hidden"));
});

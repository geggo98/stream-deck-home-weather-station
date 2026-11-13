/**
 * The plugin's real status output (pi-router.ts) fed into the Property Inspector's
 * describeStatus (ui/home-weather-pi.js). The two sides are tested separately elsewhere;
 * this file keeps them honest about the shapes they exchange (a warning that no page shows
 * was a real defect).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createPiRouter } from "../src/actions/pi-router.ts";
import { PI_EVENTS } from "../src/pi-protocol.ts";
import { FakeService, makeSnapshot, RecordingLogger } from "./actions-fixtures.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

function loadPi(): Any {
	const win: Any = {};
	vm.runInNewContext(readFileSync(join(root, "de.schwetschke.sd.home-weather-station.sdPlugin", "ui", "home-weather-pi.js"), "utf8"), { window: win });
	return win.HomeWeatherPI;
}

function setup(service: FakeService) {
	const sent: Any[] = [];
	const router = createPiRouter({
		getService: () => service,
		reply: async (payload) => {
			sent.push(payload);
		},
		openUrl: async () => {},
		getActionSettings: () => undefined,
		getGlobal: () => ({}),
		updateGlobal: async () => {},
		logger: new RecordingLogger(),
	});
	return { router, sent };
}

test("an unpersisted rotation reaches the PI status line as a visible warning, not as a plain 'Connected'", async () => {
	const service = new FakeService(makeSnapshot());
	service.state = { kind: "ok", warning: "unpersisted-rotation" };
	const { router, sent } = setup(service);
	const status = await router.accountStatus();
	assert.equal(status.state, "ok");
	assert.ok(status.warning && status.warning.length > 10, "the router must pass the warning text on");
	const shown = JSON.parse(JSON.stringify(loadPi().describeStatus(status, () => "12:00")));
	assert.equal(shown.cls, "pi-status-warn");
	assert.ok(shown.text.includes(status.warning as string), `the warning text is not on the status line: ${shown.text}`);
	assert.match(shown.text, /Warning/);

	// ... and the same through the reply the PI really receives.
	assert.equal(await router.handle("a1", { event: PI_EVENTS.getAccountStatus }), true);
	const reply = sent.at(-1) as Any;
	assert.equal(reply.event, PI_EVENTS.accountStatus);
	const viaPi = JSON.parse(JSON.stringify(loadPi().describeStatus(loadPi().statusOf(reply), () => "12:00")));
	assert.equal(viaPi.cls, "pi-status-warn");
});

test("a healthy connection is plain Connected with no warning class", async () => {
	const service = new FakeService(makeSnapshot());
	service.state = { kind: "ok" };
	const { router } = setup(service);
	const shown = JSON.parse(JSON.stringify(loadPi().describeStatus(await router.accountStatus(), () => "12:00")));
	assert.equal(shown.cls, "pi-status-ok");
	assert.ok(!/Warning/.test(shown.text));
});

test("clearCredentials is answered with clearResult that the PI can show (success and failure)", async () => {
	const ok = setup(new FakeService(makeSnapshot()));
	await ok.router.handle("a1", { event: PI_EVENTS.clearCredentials });
	const done = ok.sent.find((m) => m.event === PI_EVENTS.clearResult) as Any;
	assert.ok(done, "no clearResult reply");
	assert.equal(done.ok, true);
	assert.ok(loadPi().statusOf(done), "the PI cannot read a status from the reply");

	const failing = new FakeService(makeSnapshot());
	failing.clearCredentials = async () => {
		throw new Error("EACCES");
	};
	const bad = setup(failing);
	await bad.router.handle("a1", { event: PI_EVENTS.clearCredentials });
	const failed = bad.sent.find((m) => m.event === PI_EVENTS.clearResult) as Any;
	assert.ok(failed, "no clearResult reply after a failed clear");
	assert.equal(failed.ok, false);
	assert.ok(typeof failed.error === "string" && failed.error.length > 10, "the failure needs a user-facing text");
});

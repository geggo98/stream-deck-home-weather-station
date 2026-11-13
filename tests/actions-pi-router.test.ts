/** PI messages with a fake service: shapes, validation, secret hygiene. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createPiRouter, metricItems, moduleItems, MAX_CREDENTIAL_CHARS, SETTINGS_WRITE_FAILED_MESSAGE } from "../src/actions/pi-router.ts";
import { PI_EVENTS, type GlobalSettings } from "../src/pi-protocol.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { baseModule, BASE_ID, FakeService, makeSnapshot, NOW, outdoorModule, RecordingLogger, STATION_ID } from "./actions-fixtures.ts";

const SECRET = "s3cr3t-value-that-must-never-be-logged";

function setup(service: FakeService | undefined = new FakeService(makeSnapshot()), global: GlobalSettings = {}) {
	const sent: Array<Record<string, unknown>> = [];
	const opened: string[] = [];
	const writes: GlobalSettings[] = [];
	const logger = new RecordingLogger();
	let current = global;
	const router = createPiRouter({
		getService: () => service,
		reply: async (payload) => {
			sent.push({ ...payload });
		},
		openUrl: async (url) => {
			opened.push(url);
		},
		getActionSettings: () => ({ moduleKey: makeModuleKey(STATION_ID, BASE_ID) }),
		getGlobal: () => current,
		updateGlobal: async (patch) => {
			const next = patch(current);
			if (next) {
				current = next;
				writes.push(next);
			}
		},
		logger,
	});
	return { router, sent, opened, writes, logger, service };
}

const last = (sent: Array<Record<string, unknown>>) => sent.at(-1)!;

describe("account status", () => {
	it("maps connection state to the PI's account states", async () => {
		const service = new FakeService(makeSnapshot());
		const { router } = setup(service);
		service.state = { kind: "ok" };
		const ok = await router.accountStatus();
		assert.equal(ok.state, "ok");
		assert.equal(ok.stationCount, 1);
		assert.equal(ok.moduleCount, 4);
		assert.equal(ok.clientIdHint, "abcd");
		assert.equal(ok.lastUpdate, new Date(NOW - 60_000).toISOString());
		service.state = { kind: "auth-error", message: "revoked", since: 0 };
		assert.deepEqual([(await router.accountStatus()).state, (await router.accountStatus()).message], ["auth-error", "revoked"]);
		service.state = { kind: "loading" };
		assert.equal((await router.accountStatus()).state, "loading");
		service.state = { kind: "error", message: "timeout", since: 0, retryAt: 1 };
		assert.equal((await router.accountStatus()).state, "error");
		service.summary = { configured: false };
		service.state = { kind: "no-credentials" };
		assert.equal((await router.accountStatus()).state, "not-configured");
	});

	it("reports an error state when the service could not be created", async () => {
		const { router } = setup(undefined as never);
		const status = await createPiRouter({
			getService: () => undefined,
			reply: async () => {},
			openUrl: async () => {},
			getActionSettings: () => undefined,
			getGlobal: () => ({}),
			updateGlobal: async () => {},
			logger: new RecordingLogger(),
		}).accountStatus();
		assert.equal(status.state, "error");
		assert.ok(router);
	});

	it("answers getAccountStatus in both shapes", async () => {
		const { router, sent } = setup();
		assert.equal(await router.handle("a", { event: PI_EVENTS.getAccountStatus }), true);
		const msg = last(sent) as { event: string; state: string; status: { state: string } };
		assert.equal(msg.event, PI_EVENTS.accountStatus);
		assert.equal(msg.state, "ok");
		assert.equal(msg.status.state, "ok");
	});
});

describe("datasources", () => {
	it("getModules: items array and status; flat for one station, grouped for several", async () => {
		const { router, sent } = setup();
		await router.handle("a", { event: PI_EVENTS.getModules });
		const msg = last(sent) as { event: string; items: Array<{ label: string; value: string }>; status: unknown };
		assert.equal(msg.event, PI_EVENTS.getModules);
		assert.equal(msg.items.length, 4);
		assert.equal(msg.items[0]?.label, "Living room (base station)");
		assert.equal(msg.items[0]?.value, makeModuleKey(STATION_ID, BASE_ID));
		assert.ok(msg.status);

		const two = { ...makeSnapshot(), stations: [makeSnapshot().stations[0]!, { ...makeSnapshot().stations[0]!, id: "00:00:5e:00:53:10", name: "Other" }] };
		const grouped = moduleItems(two);
		assert.equal(grouped.length, 2);
		assert.equal(grouped[0]?.children?.length, 4);
	});

	it("always replies with an items array, even without a snapshot", async () => {
		const { router, sent } = setup(new FakeService(undefined));
		await router.handle("a", { event: PI_EVENTS.getModules });
		await router.handle("a", { event: PI_EVENTS.getMetrics });
		for (const msg of sent) assert.ok(Array.isArray((msg as { items?: unknown }).items), String(msg.event));
	});

	it("getMetrics lists what the action's module reports", async () => {
		const { router, sent } = setup();
		await router.handle("a", { event: PI_EVENTS.getMetrics });
		const items = (last(sent) as { items: Array<{ value: string }> }).items;
		assert.deepEqual(items.map((i) => i.value), ["temperature", "humidity", "co2", "noise", "pressure", "absolutePressure"]);
		const outdoor = metricItems(makeSnapshot([baseModule(), outdoorModule()]), { moduleKey: makeModuleKey(STATION_ID, outdoorModule().id) });
		assert.deepEqual(outdoor.map((i) => i.value), ["temperature", "humidity"]);
	});

	it("cleans untrusted module names", () => {
		const items = moduleItems(makeSnapshot([baseModule({ name: "A\u0000B\u202eC" })]));
		assert.equal(items[0]?.label, "A B C (base station)");
	});
});

describe("credentials", () => {
	it("passes trimmed values to the service once and never logs or echoes them", async () => {
		const service = new FakeService(makeSnapshot());
		service.setCredentialsResult = { ok: true, snapshot: makeSnapshot() };
		const { router, sent, logger } = setup(service);
		await router.handle("a", { event: PI_EVENTS.setCredentials, clientId: " id ", clientSecret: SECRET, refreshToken: "tok" });
		assert.deepEqual(service.credentialInputs, [{ clientId: "id", clientSecret: SECRET, refreshToken: "tok" }]);
		const msg = last(sent) as { event: string; ok: boolean; status: { state: string } };
		assert.equal(msg.event, PI_EVENTS.credentialsResult);
		assert.equal(msg.ok, true);
		const everything = JSON.stringify(sent) + logger.lines.join("\n");
		assert.equal(everything.includes(SECRET), false);
	});

	it("rejects missing, non-string and oversized fields without calling the service", async () => {
		const service = new FakeService(makeSnapshot());
		const { router, sent } = setup(service);
		for (const bad of [
			{ clientId: "", clientSecret: "x", refreshToken: "y" },
			{ clientId: 5, clientSecret: "x", refreshToken: "y" },
			{ clientId: "a", clientSecret: "x".repeat(MAX_CREDENTIAL_CHARS + 1), refreshToken: "y" },
			{ clientId: "a", clientSecret: "x" },
		]) {
			await router.handle("a", { event: PI_EVENTS.setCredentials, ...bad });
			assert.equal((last(sent) as { ok: boolean }).ok, false);
		}
		assert.equal(service.credentialInputs.length, 0);
	});

	it("shows the service's error text, cleaned, and a fixed text when it throws", async () => {
		const service = new FakeService(makeSnapshot());
		service.setCredentialsResult = { ok: false, error: "invalid_client\u0000" };
		const { router, sent, logger } = setup(service);
		const payload = { event: PI_EVENTS.setCredentials, clientId: "a", clientSecret: SECRET, refreshToken: "t" };
		await router.handle("a", payload);
		assert.equal((last(sent) as { error: string }).error, "invalid_client");
		service.setCredentials = async () => {
			throw new Error(`failed with ${SECRET}`);
		};
		await router.handle("a", payload);
		assert.match((last(sent) as { error: string }).error, /Saving the credentials failed/);
		assert.equal(logger.lines.join("\n").includes(SECRET), false, "an exception message may carry the secret");
	});

	it("clears credentials (answering clearResult ok) and refreshes on request", async () => {
		const service = new FakeService(makeSnapshot());
		const { router, sent } = setup(service);
		await router.handle("a", { event: PI_EVENTS.clearCredentials });
		assert.equal(service.cleared, 1);
		assert.equal(last(sent).event, PI_EVENTS.clearResult);
		assert.equal(last(sent).ok, true);
		assert.equal("error" in last(sent), false);
		await router.handle("a", { event: PI_EVENTS.refreshNow });
		assert.equal(service.refreshCalls, 1);
	});
});

describe("browser login", () => {
	it("opens the URL through the injected opener and relays the phases", async () => {
		const service = new FakeService(makeSnapshot());
		service.loginPhases = [{ phase: "waiting", redirectUri: "http://localhost:1/callback" }, { phase: "error", message: "denied" }];
		const { router, sent, opened } = setup(service);
		await router.handle("a", { event: PI_EVENTS.startBrowserLogin, clientId: "id", clientSecret: SECRET });
		assert.deepEqual(opened, [service.loginUrl]);
		const phases = sent.filter((m) => m.event === PI_EVENTS.browserLogin).map((m) => m.phase);
		assert.deepEqual(phases, ["waiting", "error"]);
		assert.equal((sent[0] as { redirectUri: string }).redirectUri, "http://localhost:1/callback");
	});

	it("refuses to open a non-https URL and reports an error to the PI", async () => {
		const service = new FakeService(makeSnapshot());
		service.loginUrl = "file:///etc/passwd";
		const { router, sent, opened } = setup(service);
		await router.handle("a", { event: PI_EVENTS.startBrowserLogin, clientId: "id", clientSecret: SECRET });
		assert.deepEqual(opened, []);
		assert.equal((last(sent) as { phase: string }).phase, "error");
		assert.equal(JSON.stringify(sent).includes(SECRET), false);
	});

	it("needs both client id and secret", async () => {
		const { router, sent, opened } = setup();
		await router.handle("a", { event: PI_EVENTS.startBrowserLogin, clientId: "id" });
		assert.deepEqual(opened, []);
		assert.equal((last(sent) as { phase: string }).phase, "error");
	});
});

describe("global settings messages", () => {
	it("returns defaults, then writes validated values through the funnel", async () => {
		const { router, sent, writes } = setup(new FakeService(makeSnapshot()), {});
		await router.handle("a", { event: PI_EVENTS.getGlobalSettings });
		assert.deepEqual(last(sent), { event: PI_EVENTS.globalSettings, pollIntervalSeconds: 300, unitSystem: "account" });
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: 5, unitSystem: "imperial" });
		assert.equal(writes[0]?.pollIntervalSeconds, 60, "clamped to the minimum");
		assert.equal(writes[0]?.unitSystem, "imperial");
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: 99999, unitSystem: "bogus" });
		assert.equal(writes[1]?.pollIntervalSeconds, 3600);
		assert.equal(writes[1]?.unitSystem, "imperial", "an invalid unit system is ignored");
	});

	it("tells the service the new poll interval (clamped), and only when it changed", async () => {
		// Without the setPollInterval call in handleSetGlobal the service keeps its old schedule.
		const service = new FakeService(makeSnapshot());
		const { router } = setup(service, { pollIntervalSeconds: 300 });
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: 5 });
		assert.equal(service.pollSeconds, 60);
		service.pollSeconds = undefined;
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: 60 });
		assert.equal(service.pollSeconds, undefined, "unchanged value is not re-applied");
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: 1e9 });
		assert.equal(service.pollSeconds, 3600);
	});

	it("replies with the values in effect, also when the write is refused, and does not touch the schedule", async () => {
		const service = new FakeService(makeSnapshot());
		const sent: Array<Record<string, unknown>> = [];
		const router = createPiRouter({
			getService: () => service,
			reply: async (p) => {
				sent.push({ ...p });
			},
			openUrl: async () => {},
			getActionSettings: () => undefined,
			getGlobal: () => ({ pollIntervalSeconds: 600 }),
			updateGlobal: async () => {
				throw new Error("global settings were never loaded");
			},
			logger: new RecordingLogger(),
		});
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: 120 });
		assert.equal(service.pollSeconds, undefined);
		assert.deepEqual(sent.at(-1), { event: PI_EVENTS.globalSettings, pollIntervalSeconds: 600, unitSystem: "account", error: SETTINGS_WRITE_FAILED_MESSAGE });
	});

	it("ignores a non-numeric poll interval", async () => {
		const { router, writes } = setup(new FakeService(makeSnapshot()), { pollIntervalSeconds: 300 });
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: "60", unitSystem: "metric" });
		assert.equal(writes[0]?.pollIntervalSeconds, 300);
		assert.equal(writes[0]?.unitSystem, "metric");
	});

	it("does not write when nothing changed", async () => {
		const { router, writes } = setup(new FakeService(makeSnapshot()), { pollIntervalSeconds: 300 });
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: 300 });
		assert.equal(writes.length, 0);
	});
});

describe("credentialsResult.saved", () => {
	const payload = { event: PI_EVENTS.setCredentials, clientId: "id", clientSecret: SECRET, refreshToken: "tok" };

	it("passes saved:true through when the credentials were persisted but the data load failed", async () => {
		// Without the pass-through the PI cannot tell this from "not saved" and asks for the consumed token again.
		const service = new FakeService(makeSnapshot());
		service.setCredentialsResult = { ok: false, saved: true, error: "Signed in, but loading station data failed. Polling will retry." };
		const { router, sent } = setup(service);
		await router.handle("a", payload);
		const msg = last(sent) as { ok: boolean; saved?: boolean; error?: string };
		assert.equal(msg.ok, false);
		assert.equal(msg.saved, true);
		assert.match(msg.error ?? "", /Polling will retry/);
	});

	it("leaves saved absent for a plain failure and for success", async () => {
		const service = new FakeService(makeSnapshot());
		service.setCredentialsResult = { ok: false, error: "invalid_grant" };
		const { router, sent } = setup(service);
		await router.handle("a", payload);
		assert.equal("saved" in last(sent), false);
		service.setCredentialsResult = { ok: true, snapshot: makeSnapshot() };
		await router.handle("a", payload);
		assert.equal("saved" in last(sent), false);
	});
});

describe("unknown messages", () => {
	it("are not claimed", async () => {
		const { router, sent } = setup();
		for (const payload of [null, "x", 5, [], {}, { event: 7 }, { event: "somethingElse" }]) {
			assert.equal(await router.handle("a", payload), false);
		}
		assert.equal(sent.length, 0);
	});
});

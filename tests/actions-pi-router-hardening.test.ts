/**
 * PI router, review round 3: what the user is told when something goes wrong.
 * Clear that fails, an unreadable credentials file, over-long pastes, a browser sign-in whose
 * status cannot be read, settings that cannot be saved, and API text that must be cleaned.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { MAX_FIELD_LENGTH } from "../src/adapter/station/credentials.ts";
import { DATA_DIR_NAME } from "../src/adapter/station/paths.ts";
import { clearFailedMessage, createPiRouter, MAX_CREDENTIAL_CHARS, moduleItems, SETTINGS_WRITE_FAILED_MESSAGE, unreadableCredentialsMessage } from "../src/actions/pi-router.ts";
import { PI_EVENTS, type GlobalSettings, type PluginToPiMessage } from "../src/pi-protocol.ts";
import { HistoryController } from "../src/actions/history-controller.ts";
import { KeyController } from "../src/actions/key-controller.ts";
import { isRememberedHistoryAction } from "../src/actions/global-settings.ts";
import { metricItems } from "../src/actions/pi-router.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { BASE_ID, FakeService, FakeSource, makeEnv, makeSnapshot, makeTwoStationSnapshot, RecordingKeySurface, RecordingLogger, STATION_ID, WIND_ID } from "./actions-fixtures.ts";

const SECRET = "s3cr3t-value-that-must-never-be-logged";

function setup(service: FakeService | undefined = new FakeService(makeSnapshot()), extra: { getGlobalError?: () => string | undefined; updateGlobal?: (patch: (c: GlobalSettings) => GlobalSettings | undefined) => Promise<void>; reply?: (m: PluginToPiMessage) => Promise<void> } = {}) {
	const sent: Array<Record<string, unknown>> = [];
	const logger = new RecordingLogger();
	const router = createPiRouter({
		getService: () => service,
		reply: extra.reply ?? (async (message) => {
			sent.push({ ...message });
		}),
		openUrl: async () => {},
		getActionSettings: () => undefined,
		getGlobal: () => ({ pollIntervalSeconds: 600 }),
		getGlobalError: extra.getGlobalError,
		updateGlobal: extra.updateGlobal ?? (async () => {}),
		logger,
	});
	return { router, sent, logger, service };
}

const last = (sent: Array<Record<string, unknown>>) => sent.at(-1)!;

describe("an unreadable credentials file", () => {
	it("is an error that names the file and the data directory, not 'not configured'", async () => {
		const service = new FakeService(makeSnapshot());
		service.summary = { configured: false, unreadable: true };
		service.state = { kind: "no-credentials" };
		const { router } = setup(service);
		const status = await router.accountStatus();
		assert.equal(status.state, "error");
		assert.match(status.message ?? "", /credentials\.json/);
		assert.ok((status.message ?? "").includes(DATA_DIR_NAME), "names the data directory");
		assert.equal(status.message, unreadableCredentialsMessage().replace(/\s+/g, " "));
		service.summary = { configured: false };
		assert.equal((await router.accountStatus()).state, "not-configured", "negative control: a missing file is still 'not configured'");
	});
});

describe("clearCredentials", () => {
	it("answers clearResult ok:false with the file location when the file cannot be removed, and logs the errno code only", async () => {
		const service = new FakeService(makeSnapshot());
		service.clearError = Object.assign(new Error(`EACCES: permission denied, unlink '/home/someone/${SECRET}'`), { code: "EACCES" });
		const { router, sent, logger } = setup(service);
		await router.handle("a", { event: PI_EVENTS.clearCredentials });
		const msg = last(sent) as { event: string; ok: boolean; error: string; status: { state: string } };
		assert.equal(msg.event, PI_EVENTS.clearResult);
		assert.equal(msg.ok, false);
		assert.equal(msg.error, clearFailedMessage());
		assert.match(msg.error, /credentials\.json/);
		assert.ok(msg.error.includes(DATA_DIR_NAME));
		assert.ok(msg.status, "the status still travels with the answer");
		assert.ok(logger.lines.some((line) => line.startsWith("error") && line.includes("EACCES")), "errno code logged");
		assert.equal(logger.lines.join("\n").includes(SECRET), false, "the error message (a path) is not logged");
	});

	it("without a service it says so instead of claiming success", async () => {
		const { router, sent } = setup(undefined as never);
		const bare = createPiRouter({ getService: () => undefined, reply: async (m) => void sent.push({ ...m }), openUrl: async () => {}, getActionSettings: () => undefined, getGlobal: () => ({}), updateGlobal: async () => {}, logger: new RecordingLogger() });
		await bare.handle("a", { event: PI_EVENTS.clearCredentials });
		assert.equal(last(sent).ok, false);
		assert.ok(router);
	});
});

describe("credential fields from the PI", () => {
	it("the limit is the adapter's 512 characters (the PI uses the same number)", () => {
		assert.equal(MAX_CREDENTIAL_CHARS, MAX_FIELD_LENGTH);
		assert.equal(MAX_FIELD_LENGTH, 512);
	});

	const good = { clientId: "id", clientSecret: SECRET, refreshToken: "tok" };

	it("a too-long paste says 'too long', a missing field says 'required', a pasted line break is named", async () => {
		const service = new FakeService(makeSnapshot());
		const { router, sent } = setup(service);
		const errorFor = async (patch: Record<string, unknown>): Promise<string> => {
			await router.handle("a", { event: PI_EVENTS.setCredentials, ...good, ...patch });
			return (last(sent) as { error: string }).error;
		};
		assert.match(await errorFor({ clientSecret: "x".repeat(MAX_CREDENTIAL_CHARS + 1) }), /client secret is too long/);
		assert.match(await errorFor({ clientId: "   " }), /client ID is required/);
		assert.match(await errorFor({ refreshToken: undefined }), /refresh token is required/);
		assert.match(await errorFor({ refreshToken: "ab cd" }), /refresh token contains spaces or control characters/);
		assert.match(await errorFor({ clientId: "a\nb" }), /client ID contains spaces or control characters/);
		assert.equal(service.credentialInputs.length, 0);
		assert.equal(JSON.stringify(sent).includes(SECRET), false);
	});

	it("exactly MAX_CREDENTIAL_CHARS is accepted", async () => {
		const service = new FakeService(makeSnapshot());
		service.setCredentialsResult = { ok: true, snapshot: makeSnapshot() };
		const { router } = setup(service);
		await router.handle("a", { event: PI_EVENTS.setCredentials, ...good, refreshToken: "x".repeat(MAX_CREDENTIAL_CHARS) });
		assert.equal(service.credentialInputs.length, 1);
	});

	it("the browser sign-in applies the same strict check BEFORE anything is opened", async () => {
		const service = new FakeService(makeSnapshot());
		const { router, sent } = setup(service);
		for (const [clientId, clientSecret, pattern] of [
			["x".repeat(MAX_CREDENTIAL_CHARS + 1), SECRET, /client ID is too long/],
			["id", "a b", /client secret contains spaces/],
			["", SECRET, /client ID is required/],
		] as const) {
			await router.handle("a", { event: PI_EVENTS.startBrowserLogin, clientId, clientSecret });
			const msg = last(sent) as { phase: string; message: string };
			assert.equal(msg.phase, "error");
			assert.match(msg.message, pattern);
		}
		assert.equal(sent.some((m) => m.phase === "waiting"), false);
		assert.equal(JSON.stringify(sent).includes(SECRET), false);
	});
});

describe("browser sign-in: the PI never sticks on 'Waiting'", () => {
	it("sends 'done' even when the status behind it cannot be read, and logs it", async () => {
		const service = new FakeService(makeSnapshot());
		service.loginPhases = [{ phase: "waiting", redirectUri: "http://localhost:1/callback" }, { phase: "done" }];
		const { router, sent, logger } = setup(service);
		service.getCredentialSummary = async () => {
			throw Object.assign(new Error("boom"), { code: "EIO" });
		};
		await router.handle("a", { event: PI_EVENTS.startBrowserLogin, clientId: "id", clientSecret: SECRET });
		await new Promise((resolve) => setImmediate(resolve));
		const phases = sent.filter((m) => m.event === PI_EVENTS.browserLogin).map((m) => m.phase);
		assert.deepEqual(phases, ["waiting", "done"]);
		assert.equal("status" in (sent.at(-1) as object), false, "no status to send, but 'done' is");
		assert.ok(logger.lines.some((line) => line.startsWith("warn") && line.includes("EIO")));
	});

	it("sends 'done' WITH the status when it can be read", async () => {
		const service = new FakeService(makeSnapshot());
		service.loginPhases = [{ phase: "done" }];
		const { router, sent } = setup(service);
		await router.handle("a", { event: PI_EVENTS.startBrowserLogin, clientId: "id", clientSecret: SECRET });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal((last(sent) as { status: { state: string } }).status.state, "ok");
	});
});

describe("global settings that cannot be saved", () => {
	it("a refused write answers with an error text and the values still in effect", async () => {
		const { router, sent } = setup(undefined, {
			updateGlobal: async () => {
				throw new Error("disk full");
			},
		});
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: 120 });
		const msg = last(sent) as { pollIntervalSeconds: number; error: string };
		assert.equal(msg.error, SETTINGS_WRITE_FAILED_MESSAGE);
		assert.equal(msg.pollIntervalSeconds, 600);
	});

	it("when the load failed, the answer says why and getGlobalSettings carries the same text", async () => {
		const text = "Settings could not be loaded; changes cannot be saved this session. Restart Stream Deck.";
		const { router, sent } = setup(undefined, {
			getGlobalError: () => text,
			updateGlobal: async () => {
				throw new Error("global settings were never loaded - refusing to overwrite them");
			},
		});
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, unitSystem: "metric" });
		assert.equal((last(sent) as { error: string }).error, text);
		await router.handle("a", { event: PI_EVENTS.getGlobalSettings });
		assert.equal((last(sent) as { error: string }).error, text);
	});

	it("a successful write carries no error field", async () => {
		const { router, sent } = setup();
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, unitSystem: "metric" });
		assert.equal("error" in last(sent), false);
	});

	it("does not touch the poll schedule when the write failed", async () => {
		const service = new FakeService(makeSnapshot());
		const { router } = setup(service, {
			updateGlobal: async () => {
				throw new Error("disk full");
			},
		});
		await router.handle("a", { event: PI_EVENTS.setGlobalSettings, pollIntervalSeconds: 120 });
		assert.equal(service.pollSeconds, undefined);
	});
});

describe("text from the API is cleaned before it reaches the PI", () => {
	const dirty = "bad\u0000name\u202e\u200b!";

	it("station names (grouped items) and module names", () => {
		const two = makeTwoStationSnapshot();
		const stations = two.stations.map((station, i) => (i === 0 ? { ...station, name: dirty } : station));
		const items = moduleItems({ ...two, stations });
		assert.equal(items[0]?.label, "bad name !");
	});

	it("connection error messages", async () => {
		const service = new FakeService(makeSnapshot());
		service.state = { kind: "error", message: dirty, since: 0, retryAt: 1 };
		const { router } = setup(service);
		assert.equal((await router.accountStatus()).message, "bad name !");
		service.state = { kind: "auth-error", message: dirty, since: 0 };
		assert.equal((await router.accountStatus()).message, "bad name !");
	});

	it("the service's setCredentials error and the browser sign-in's error phase", async () => {
		const service = new FakeService(makeSnapshot());
		service.setCredentialsResult = { ok: false, error: dirty };
		service.loginPhases = [{ phase: "error", message: dirty }];
		const { router, sent } = setup(service);
		await router.handle("a", { event: PI_EVENTS.setCredentials, clientId: "a", clientSecret: "b", refreshToken: "c" });
		assert.equal((last(sent) as { error: string }).error, "bad name !");
		await router.handle("a", { event: PI_EVENTS.startBrowserLogin, clientId: "a", clientSecret: "b" });
		assert.equal((last(sent) as { message: string }).message, "bad name !");
	});

	it("a long error text is cut", async () => {
		const service = new FakeService(makeSnapshot());
		service.setCredentialsResult = { ok: false, error: "x".repeat(1000) };
		const { router, sent } = setup(service);
		await router.handle("a", { event: PI_EVENTS.setCredentials, clientId: "a", clientSecret: "b", refreshToken: "c" });
		assert.ok(((last(sent) as { error: string }).error).length <= 300);
	});
});

describe("a failing reply is logged by its code, not thrown", () => {
	it("keeps the router alive", async () => {
		const { router, logger } = setup(undefined, {
			reply: async () => {
				throw Object.assign(new Error(`socket closed ${SECRET}`), { code: "EPIPE" });
			},
		});
		await router.handle("a", { event: PI_EVENTS.getAccountStatus });
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(logger.lines.some((line) => line.includes("EPIPE")));
		assert.equal(logger.lines.join("\n").includes(SECRET), false);
	});
});

describe("the history key's metric dropdown", () => {
	const keyOf = (id: string) => ({ moduleKey: makeModuleKey(STATION_ID, id) });

	it("offers only measurements that have a history (no station pressure, no gusts)", () => {
		const snapshot = makeSnapshot();
		const all = metricItems(snapshot, keyOf(BASE_ID)).map((i) => i.value);
		assert.ok(all.includes("absolutePressure"));
		assert.deepEqual(metricItems(snapshot, keyOf(BASE_ID), { historyOnly: true }).map((i) => i.value), ["temperature", "humidity", "co2", "noise", "pressure"]);
		assert.deepEqual(metricItems(snapshot, keyOf(WIND_ID), { historyOnly: true }).map((i) => i.value), ["wind"]);
		assert.ok(metricItems(snapshot, keyOf(WIND_ID)).some((i) => i.value === "gust"));
		assert.ok(metricItems(undefined, undefined, { historyOnly: true }).every((i) => i.value !== "gust" && i.value !== "absolutePressure"));
	});

	it("the router applies it for a history key and not for a measurement key (the controllers register themselves)", async () => {
		const snapshot = makeSnapshot();
		const env = makeEnv(new FakeSource(snapshot));
		const history = new HistoryController(env);
		const keys = new KeyController(env);
		await history.appear(new RecordingKeySurface("history-1"), keyOf(BASE_ID), "temperature");
		await keys.appear(new RecordingKeySurface("temp-1"), keyOf(BASE_ID), "temperature");
		assert.equal(isRememberedHistoryAction("history-1"), true);
		assert.equal(isRememberedHistoryAction("temp-1"), false);
		const sent: Array<Record<string, unknown>> = [];
		const router = createPiRouter({
			getService: () => new FakeService(snapshot),
			reply: async (m) => void sent.push({ ...m }),
			openUrl: async () => {},
			getActionSettings: () => keyOf(BASE_ID),
			isHistoryAction: isRememberedHistoryAction,
			getGlobal: () => ({}),
			updateGlobal: async () => {},
			logger: new RecordingLogger(),
		});
		await router.handle("history-1", { event: PI_EVENTS.getMetrics });
		assert.equal(((last(sent) as { items: Array<{ value: string }> }).items).some((i) => i.value === "absolutePressure"), false);
		await router.handle("temp-1", { event: PI_EVENTS.getMetrics });
		assert.equal(((last(sent) as { items: Array<{ value: string }> }).items).some((i) => i.value === "absolutePressure"), true);
		history.disappear("history-1");
		assert.equal(isRememberedHistoryAction("history-1"), false, "forgotten on disappear");
		history.dispose();
		keys.dispose();
	});
});

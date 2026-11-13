/**
 * "The renewed sign-in could not be saved" arrives as an `error` connection state while data
 * keeps flowing. The data is current: nothing may be dimmed or aged for it; the text belongs in
 * the account status. Any OTHER error still dims (negative control).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { UNPERSISTED_ROTATION_MESSAGE } from "../src/adapter/station/token-manager.ts";
import type { ConnectionState } from "../src/adapter/station/types.ts";
import { DialController } from "../src/actions/dial-controller.ts";
import { KeyController } from "../src/actions/key-controller.ts";
import { createPiRouter } from "../src/actions/pi-router.ts";
import { buildHistoryView } from "../src/render/history-view.ts";
import { buildKeyView } from "../src/render/key-view.ts";
import { buildNavView } from "../src/render/nav-view.ts";
import { classify, isUnpersistedRotation } from "../src/render/status.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { BASE_ID, FakeService, FakeSource, makeEnv, makeSnapshot, NOW, okHistory, RecordingDialSurface, RecordingKeySurface, RecordingLogger, STATION_ID } from "./actions-fixtures.ts";

const unpersisted: ConnectionState = { kind: "error", message: UNPERSISTED_ROTATION_MESSAGE, since: NOW, retryAt: NOW + 300_000 };
const transient: ConnectionState = { kind: "error", message: "network down", since: NOW, retryAt: NOW + 300_000 };
const moduleKey = makeModuleKey(STATION_ID, BASE_ID);

describe("unpersisted token rotation does not make data look stale", () => {
	it("is recognised by its exact message only", () => {
		assert.equal(isUnpersistedRotation(unpersisted), true);
		assert.equal(isUnpersistedRotation(transient), false);
		assert.equal(isUnpersistedRotation({ kind: "ok" }), false);
	});

	it("classify: value stays fresh, and a real error still marks it stale", () => {
		const input = { hasSource: true, snapshot: makeSnapshot(), moduleKey, metric: "temperature" as const, now: NOW };
		assert.equal((classify({ ...input, connection: unpersisted }) as { stale: boolean }).stale, false);
		assert.equal((classify({ ...input, connection: transient }) as { stale: boolean }).stale, true);
	});

	it("the key face is identical to the 'ok' face; a transient error differs", () => {
		const base = { metric: "temperature" as const, settings: { moduleKey }, global: {}, hasSource: true, snapshot: makeSnapshot(), now: NOW };
		const ok = buildKeyView({ ...base, connection: { kind: "ok" } });
		const flagged = buildKeyView({ ...base, connection: unpersisted });
		assert.deepEqual(flagged.title, ok.title);
		assert.equal(flagged.svg, ok.svg);
		assert.notEqual(buildKeyView({ ...base, connection: transient }).svg, ok.svg);
	});

	it("the real controllers paint it like ok, key and dial", async () => {
		const source = new FakeSource(makeSnapshot());
		source.state = unpersisted;
		const key = new RecordingKeySurface();
		await new KeyController(makeEnv(source)).appear(key, { moduleKey }, "temperature");
		assert.equal(key.lastTitle, "21.4°C\nLiving r…", "no age hint");
		const dial = new RecordingDialSurface();
		await new DialController(makeEnv(source)).appear(dial, { moduleKey, followFocus: false });
		assert.equal(dial.last?.value.opacity, 1);
		assert.equal(dial.last?.title.value, "Temperature");
	});

	it("history and navigation faces are not dimmed by it either", () => {
		const snapshot = makeSnapshot();
		const request = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" as const, window: "24h" as const };
		const history = (connection: ConnectionState) =>
			buildHistoryView({ metric: "temperature", settings: { moduleKey }, global: {}, hasSource: true, connection, snapshot, now: NOW, window: "24h", result: okHistory(request) }).svg;
		assert.equal(history(unpersisted), history({ kind: "ok" }));
		assert.notEqual(history(transient), history({ kind: "ok" }));
		const focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" as const };
		const nav = (connection: ConnectionState) => buildNavView({ kind: "refresh", hasSource: true, connection, snapshot, focus, now: NOW }).svg;
		assert.equal(nav(unpersisted), nav({ kind: "ok" }));
		assert.notEqual(nav(transient), nav({ kind: "ok" }));
	});

	it("shows up in the account status message, as a warning on an ok account", async () => {
		const service = new FakeService(makeSnapshot());
		const router = createPiRouter({
			getService: () => service,
			reply: async () => {},
			openUrl: async () => {},
			getActionSettings: () => undefined,
			getGlobal: () => ({}),
			updateGlobal: async () => {},
			logger: new RecordingLogger(),
		});
		service.state = unpersisted;
		const status = await router.accountStatus();
		assert.equal(status.state, "ok");
		assert.equal(status.message, UNPERSISTED_ROTATION_MESSAGE);
		service.state = transient;
		assert.equal((await router.accountStatus()).state, "error", "a real error stays an error");
		service.state = { kind: "ok" };
		assert.equal((await router.accountStatus()).message, undefined);
	});
});

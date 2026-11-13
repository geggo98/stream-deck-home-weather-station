/**
 * "The renewed sign-in could not be saved" arrives as an `ok` connection state with a warning
 * while data keeps flowing. The data is current: nothing may be dimmed or aged for it, but every
 * face carries a non-dimming marker (tile dot, dial indicator colour and title suffix), and the
 * text belongs in the account status. Any real error still dims (negative control).
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
import { classify, hasWarning } from "../src/render/status.ts";
import { WARNING_COLOUR } from "../src/render/colour.ts";
import { buildDialFeedback, buildHistoryStrip, WARNING_MARK } from "../src/render/dial-feedback.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { BASE_ID, FakeService, FakeSource, makeEnv, makeSnapshot, NOW, okHistory, RecordingDialSurface, RecordingKeySurface, RecordingLogger, STATION_ID } from "./actions-fixtures.ts";

const unpersisted: ConnectionState = { kind: "ok", warning: "unpersisted-rotation" };
const transient: ConnectionState = { kind: "error", message: "network down", since: NOW, retryAt: NOW + 300_000 };
const moduleKey = makeModuleKey(STATION_ID, BASE_ID);
const DOT = `<circle cx="14" cy="14" r="6" fill="${WARNING_COLOUR}"/>`;

describe("unpersisted token rotation: data stays current, the faces carry a marker", () => {
	it("is recognised by the connection warning only", () => {
		assert.equal(hasWarning(unpersisted), true);
		assert.equal(hasWarning(transient), false);
		assert.equal(hasWarning({ kind: "ok" }), false);
	});

	it("classify: value stays fresh and flagged; a real error still marks it stale", () => {
		const input = { hasSource: true, snapshot: makeSnapshot(), moduleKey, metric: "temperature" as const, now: NOW };
		const flagged = classify({ ...input, connection: unpersisted }) as { stale: boolean; warning: boolean };
		assert.deepEqual([flagged.stale, flagged.warning], [false, true]);
		const plain = classify({ ...input, connection: { kind: "ok" } }) as { stale: boolean; warning: boolean };
		assert.deepEqual([plain.stale, plain.warning], [false, false]);
		assert.equal((classify({ ...input, connection: transient }) as { stale: boolean }).stale, true);
	});

	it("the key face keeps the value at full strength and differs from 'ok' by the warning dot only", () => {
		const base = { metric: "temperature" as const, settings: { moduleKey }, global: {}, hasSource: true, snapshot: makeSnapshot(), now: NOW };
		const ok = buildKeyView({ ...base, connection: { kind: "ok" } });
		const flagged = buildKeyView({ ...base, connection: unpersisted });
		assert.deepEqual(flagged.title, ok.title, "no age hint, same text");
		assert.ok(flagged.svg.includes(DOT), "warning dot");
		assert.equal(ok.svg.includes(DOT), false);
		assert.equal(flagged.svg.replace(DOT, ""), ok.svg, "nothing else changed: not dimmed");
		assert.notEqual(buildKeyView({ ...base, connection: transient }).svg, ok.svg);
	});

	it("when the data is ALSO stale, staleness shows (dimmed, stale dot) and no second marker appears", () => {
		const base = { metric: "temperature" as const, settings: { moduleKey }, global: {}, hasSource: true, snapshot: makeSnapshot(), now: NOW + 3 * 3_600_000 };
		const view = buildKeyView({ ...base, connection: unpersisted });
		assert.equal(view.svg.split("<circle").length - 1, 1, "one dot");
	});

	it("the real controllers paint the key with the dot and the dial with a flagged title and bar", async () => {
		const source = new FakeSource(makeSnapshot());
		source.state = unpersisted;
		const key = new RecordingKeySurface();
		await new KeyController(makeEnv(source)).appear(key, { moduleKey }, "temperature");
		assert.equal(key.lastTitle, "21.4°C\nLiving r…", "no age hint");
		const svg = Buffer.from((key.lastImage ?? "").replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");
		assert.ok(svg.includes(DOT), "the painted image carries the warning dot");
		const dial = new RecordingDialSurface();
		await new DialController(makeEnv(source)).appear(dial, { moduleKey, followFocus: false });
		assert.equal(dial.last?.value.opacity, 1);
		assert.equal(dial.last?.title.value, `Temperature ${WARNING_MARK}`);
		assert.equal(dial.last?.indicator.bar_fill_c, WARNING_COLOUR);
		assert.equal(dial.last?.indicator.opacity, 1);
	});

	it("the dial strip without a warning has neither the suffix nor the warning bar (negative control)", () => {
		const common = { metric: "temperature" as const, settings: { moduleKey }, global: {}, hasSource: true, snapshot: makeSnapshot(), now: NOW, showMinMax: false };
		const plain = buildDialFeedback({ ...common, connection: { kind: "ok" } });
		assert.equal(plain.title.value, "Temperature");
		assert.notEqual(plain.indicator.bar_fill_c, WARNING_COLOUR);
	});

	it("history and navigation faces are not dimmed by it, and carry the dot", () => {
		const snapshot = makeSnapshot();
		const request = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" as const, window: "24h" as const };
		const history = (connection: ConnectionState) =>
			buildHistoryView({ metric: "temperature", settings: { moduleKey }, global: {}, hasSource: true, connection, snapshot, now: NOW, window: "24h", result: okHistory(request) }).svg;
		assert.equal(history(unpersisted).replace(DOT, ""), history({ kind: "ok" }));
		assert.ok(history(unpersisted).includes(DOT));
		assert.notEqual(history(transient), history({ kind: "ok" }));
		const strip = (connection: ConnectionState) =>
			buildHistoryStrip({ metric: "temperature", settings: { moduleKey }, global: {}, hasSource: true, connection, snapshot, now: NOW, window: "24h", result: okHistory(request) });
		assert.equal(strip(unpersisted).title.value, `Temperature ${WARNING_MARK}`);
		assert.equal(strip(unpersisted).title.opacity, 1);
		assert.equal(strip({ kind: "ok" }).title.value, "Temperature");
		const focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" as const };
		const nav = (kind: "refresh" | "next-metric" | "info", connection: ConnectionState) => buildNavView({ kind, hasSource: true, connection, snapshot, focus, now: NOW }).svg;
		for (const kind of ["refresh", "next-metric", "info"] as const) {
			assert.equal(nav(kind, unpersisted).replace(DOT, ""), nav(kind, { kind: "ok" }), kind);
			assert.ok(nav(kind, unpersisted).includes(DOT), kind);
			if (kind !== "next-metric") assert.notEqual(nav(kind, transient), nav(kind, { kind: "ok" }), kind);
		}
	});

	it("shows up in the account status as a warning on an ok account, and only then", async () => {
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
		assert.equal(status.warning, UNPERSISTED_ROTATION_MESSAGE);
		assert.equal(status.message, undefined, "the text is a warning, not an error message");
		service.state = transient;
		const failed = await router.accountStatus();
		assert.equal(failed.state, "error", "a real error stays an error");
		assert.equal(failed.warning, undefined);
		service.state = { kind: "ok" };
		assert.equal((await router.accountStatus()).warning, undefined);
	});
});

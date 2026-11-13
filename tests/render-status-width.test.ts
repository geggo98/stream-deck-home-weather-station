/**
 * Every status text a key can show fits the key: no line is longer than MAX_STATUS_LINE_CHARS
 * (a key title is about 8 to 10 characters wide; longer text is cut or wrapped mid-word).
 * The texts come from three tables: the display table (title.ts), the history table
 * (history-view.ts) and the navigation keys (nav-view.ts); all three are exercised here.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildDialFeedback, buildHistoryStrip } from "../src/render/dial-feedback.ts";
import { buildHistoryView } from "../src/render/history-view.ts";
import { buildNavView, type NavKind } from "../src/render/nav-view.ts";
import { makeModuleKey } from "../src/render/select.ts";
import { MAX_STATUS_LINE_CHARS, STATUS_WORDS } from "../src/render/title.ts";
import { baseModule, BASE_ID, makeSnapshot, NOW, STATION_ID } from "./actions-fixtures.ts";
import type { ConnectionState, HistoryRequest, HistoryResult } from "../src/adapter/station/types.ts";

const longest = (text: string | undefined): number => Math.max(0, ...(text ?? "").split("\n").map((line) => Array.from(line).length));

describe("status texts fit the key", () => {
	it("the display table", () => {
		for (const [kind, word] of Object.entries(STATUS_WORDS)) {
			assert.ok(longest(word) <= MAX_STATUS_LINE_CHARS, `${kind}: ${JSON.stringify(word)}`);
		}
	});

	it("the navigation keys, in their blocked states", () => {
		// One station, one module that reports one value: every navigation key has nowhere to go.
		const snapshot = makeSnapshot([baseModule({ values: { temperature: 20 } })]);
		const focus = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature" as const };
		const expected: Partial<Record<NavKind, string>> = {
			"next-metric": "Only one\nvalue",
			"prev-metric": "Only one\nvalue",
			"next-sensor": "No other\nsensor",
			"prev-sensor": "No other\nsensor",
			"next-station": "One\nstation",
			"prev-station": "One\nstation",
		};
		for (const [kind, title] of Object.entries(expected)) {
			const view = buildNavView({ kind: kind as NavKind, hasSource: true, connection: { kind: "ok" }, snapshot, focus, now: NOW });
			assert.equal(view.title, title, kind);
			assert.ok(longest(view.title) <= MAX_STATUS_LINE_CHARS, kind);
		}
	});

	it("the history table", () => {
		const moduleKey = makeModuleKey(STATION_ID, BASE_ID);
		const request: HistoryRequest = { stationId: STATION_ID, moduleId: BASE_ID, metric: "temperature", window: "24h" };
		const errors: HistoryResult[] = ["auth", "rate", "transient", "other"].map((reason) => ({ kind: "error", request, message: "x", reason }) as HistoryResult);
		const results: Array<HistoryResult | undefined> = [undefined, { kind: "ok", request, points: [], stepMs: 1800_000, fetchedAt: NOW }, ...errors];
		const connections: ConnectionState[] = [{ kind: "ok" }, { kind: "no-credentials" }];
		for (const result of results) {
			for (const connection of connections) {
				const view = buildHistoryView({ metric: "temperature", settings: { moduleKey }, global: {}, hasSource: true, connection, snapshot: makeSnapshot(), now: NOW, window: "24h", result });
				assert.ok(longest(view.title) <= MAX_STATUS_LINE_CHARS, JSON.stringify(view.title));
			}
		}
		const gust = buildHistoryView({ metric: "gust", settings: { moduleKey }, global: {}, hasSource: true, connection: { kind: "ok" }, snapshot: makeSnapshot(), now: NOW, window: "24h", result: undefined });
		assert.ok(longest(gust.title) <= MAX_STATUS_LINE_CHARS);
	});

	it("the dial strip says a status in ONE line: the line break is for the narrow key", () => {
		const common = { metric: "temperature" as const, settings: { moduleKey: "" }, global: {}, hasSource: true, connection: { kind: "ok" } as ConnectionState, snapshot: makeSnapshot(), now: NOW };
		assert.equal(buildDialFeedback({ ...common, showMinMax: false }).value.value, "Pick module");
		assert.equal(buildHistoryStrip({ ...common, window: "24h", result: undefined }).value.value, "Pick module");
	});
});

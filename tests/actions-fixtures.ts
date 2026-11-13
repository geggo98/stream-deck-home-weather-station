/**
 * Fictional fixtures and fakes shared by the plugin-layer tests.
 *
 * Everything here is invented: MAC addresses come from the documentation range
 * 00:00:5e:00:53:xx, names are generic. No real account, station or place.
 * SDK-free on purpose (importing @elgato/streamdeck rotates log files in parallel test
 * processes).
 */

import type { AdapterLogger } from "../src/adapter/logging.ts";
import type { BrowserLoginPhase, CredentialInput, SetCredentialsResult, WeatherService } from "../src/adapter/station/service.ts";
import type {
	ConnectionState,
	CredentialSummary,
	HistoryRequest,
	HistoryResult,
	ModuleData,
	PollerSubscription,
	StationSnapshot,
	UnitPreferences,
} from "../src/adapter/station/types.ts";
import type { DialFeedbackPayload } from "../src/render/dial-feedback.ts";
import type { GlobalSettings } from "../src/pi-protocol.ts";
import type { ActionSettings } from "../src/focus/settings.ts";
import type { ControllerEnv } from "../src/actions/controller-base.ts";
import type { DialSurface } from "../src/actions/dial-controller.ts";
import type { KeySurface } from "../src/actions/key-controller.ts";
import { FocusStore } from "../src/focus/focus-store.ts";
import type { Focus } from "../src/focus/navigate.ts";
import type { HistoryStripPayload } from "../src/render/dial-feedback.ts";

export const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
export const MIN = 60_000;

export const STATION_ID = "00:00:5e:00:53:01";
export const BASE_ID = "00:00:5e:00:53:01";
export const OUTDOOR_ID = "00:00:5e:00:53:02";
export const WIND_ID = "00:00:5e:00:53:03";
export const RAIN_ID = "00:00:5e:00:53:04";

/** The second station of the two-station fixture (the owner has one, so this is theory). */
export const STATION_B_ID = "00:00:5e:00:53:11";
export const BASE_B_ID = "00:00:5e:00:53:11";
export const OUTDOOR_B_ID = "00:00:5e:00:53:12";

export const METRIC_PREFS: UnitPreferences = { unitSystem: "metric", windUnit: "kmh", pressureUnit: "mbar" };

export function baseModule(overrides: Partial<ModuleData> = {}): ModuleData {
	return {
		id: BASE_ID,
		type: "NAMain",
		role: "base",
		name: "Living room",
		reachable: true,
		measuredAt: NOW - 2 * MIN,
		values: {
			temperature: 21.43,
			humidity: 45,
			co2: 612,
			noise: 38,
			pressure: 1013.2,
			absolutePressure: 1000.4,
			tempMin: 19.2,
			tempMax: 22.8,
			tempTrend: 1,
			pressureTrend: 0,
		},
		...overrides,
	};
}

export function outdoorModule(overrides: Partial<ModuleData> = {}): ModuleData {
	return {
		id: OUTDOOR_ID,
		type: "NAModule1",
		role: "outdoor",
		name: "Garden",
		reachable: true,
		measuredAt: NOW - 3 * MIN,
		batteryPercent: 80,
		values: { temperature: 8.4, humidity: 80, tempMin: 3.1, tempMax: 9, tempTrend: -1 },
		...overrides,
	};
}

export function windModule(): ModuleData {
	return {
		id: WIND_ID,
		type: "NAModule2",
		role: "wind",
		name: "Wind gauge",
		reachable: true,
		measuredAt: NOW - 3 * MIN,
		values: { windStrength: 18, windAngle: 200, gustStrength: 33, gustAngle: 220 },
	};
}

export function rainModule(): ModuleData {
	return {
		id: RAIN_ID,
		type: "NAModule3",
		role: "rain",
		name: "Rain gauge",
		reachable: true,
		measuredAt: NOW - 3 * MIN,
		values: { rain: 0.3, rain1h: 1.2, rain24h: 7.6 },
	};
}

export function makeSnapshot(
	modules: ModuleData[] = [baseModule(), outdoorModule(), windModule(), rainModule()],
	preferences: UnitPreferences = METRIC_PREFS,
): StationSnapshot {
	return { fetchedAt: NOW - MIN, stations: [{ id: STATION_ID, name: "Test Station", modules }], preferences };
}

/**
 * Two stations. A: base, outdoor, wind, rain (like `makeSnapshot`). B: base (no CO2, no noise)
 * and an outdoor module; its temperatures differ from A's so a test can tell them apart.
 */
export function makeTwoStationSnapshot(): StationSnapshot {
	const one = makeSnapshot();
	const second: StationSnapshot["stations"][number] = {
		id: STATION_B_ID,
		name: "Second Station",
		modules: [
			baseModule({
				id: BASE_B_ID,
				name: "Attic",
				values: { temperature: 17.9, humidity: 55, pressure: 1009.1, absolutePressure: 996.2, tempMin: 15, tempMax: 19, tempTrend: 0, pressureTrend: 1 },
			}),
			outdoorModule({ id: OUTDOOR_B_ID, name: "Balcony", batteryPercent: 12, values: { temperature: 4.2, humidity: 71 } }),
		],
	};
	return { ...one, stations: [...one.stations, second] };
}

/** A real FocusStore over an in-memory "global settings" object; `writes` records what the funnel was asked to persist. */
export function makeFocusStore(initial?: Focus): { store: FocusStore; global: GlobalSettings; writes: GlobalSettings[]; failWrites: { value: boolean } } {
	const global: GlobalSettings = initial ? { focus: { ...initial } } : {};
	const writes: GlobalSettings[] = [];
	const failWrites = { value: false };
	const store = new FocusStore({
		getGlobal: () => global,
		update: async (patch) => {
			if (failWrites.value) throw new Error("write refused");
			const next = patch(global);
			if (next === undefined) return;
			Object.assign(global, next);
			writes.push(structuredClone(next));
		},
		logger: { warn: () => {} },
	});
	return { store, global, writes, failWrites };
}

export function historyPoints(count: number, stepMs: number, end: number = NOW, value: (i: number) => number = (i) => 10 + i): Array<{ t: number; v: number }> {
	return Array.from({ length: count }, (_, i) => ({ t: end - (count - i) * stepMs, v: value(i) }));
}

export function okHistory(request: HistoryRequest, points = historyPoints(24, 30 * MIN)): HistoryResult {
	return { kind: "ok", request, points, stepMs: 30 * MIN, fetchedAt: NOW };
}

export class FakeSource {
	snapshot: StationSnapshot | undefined;
	state: ConnectionState = { kind: "ok" };
	refreshCalls = 0;
	readonly listeners = new Set<() => void>();

	constructor(snapshot?: StationSnapshot) {
		this.snapshot = snapshot;
	}

	getSnapshot(): StationSnapshot | undefined {
		return this.snapshot;
	}

	getConnectionState(): ConnectionState {
		return this.state;
	}

	subscribe(listener: () => void): PollerSubscription {
		this.listeners.add(listener);
		return {
			unsubscribe: () => {
				this.listeners.delete(listener);
			},
		};
	}

	async refresh(): Promise<void> {
		this.refreshCalls++;
	}

	async credentialsChanged(): Promise<void> {}

	/** Change something and tell subscribers, like the real poller. */
	emit(change?: { snapshot?: StationSnapshot | undefined; state?: ConnectionState }): void {
		if (change && "snapshot" in change) this.snapshot = change.snapshot;
		if (change?.state) this.state = change.state;
		for (const listener of [...this.listeners]) listener();
	}
}

export class FakeService extends FakeSource implements WeatherService {
	summary: CredentialSummary = { configured: true, clientIdHint: "abcd" };
	pollSeconds: number | undefined;
	cleared = 0;
	disposed = 0;
	credentialInputs: CredentialInput[] = [];
	setCredentialsResult: SetCredentialsResult = { ok: false, error: "not set" };
	loginPhases: BrowserLoginPhase[] = [];
	loginUrl = "https://auth.example.test/authorize?state=x";
	/** Every request getHistory saw. */
	historyCalls: HistoryRequest[] = [];
	/** What getHistory answers; a function sees the request. */
	historyAnswer: HistoryResult | ((request: HistoryRequest) => HistoryResult) | undefined;
	/** While set, getHistory waits for it before answering (to test requests in flight). */
	historyGate: Promise<void> | undefined;

	async getHistory(request: HistoryRequest): Promise<HistoryResult> {
		this.historyCalls.push(request);
		if (this.historyGate) await this.historyGate;
		const answer = this.historyAnswer;
		return typeof answer === "function" ? answer(request) : (answer ?? okHistory(request));
	}

	async getCredentialSummary(): Promise<CredentialSummary> {
		return this.summary;
	}
	async setCredentials(input: CredentialInput): Promise<SetCredentialsResult> {
		this.credentialInputs.push(input);
		return this.setCredentialsResult;
	}
	/** When set, clearCredentials rejects with it (the file could not be removed). */
	clearError: Error | undefined;
	async clearCredentials(): Promise<void> {
		this.cleared++;
		if (this.clearError) throw this.clearError;
	}
	async startBrowserLogin(
		_input: { clientId: string; clientSecret: string },
		openUrl: (url: string) => Promise<void>,
		onPhase: (phase: BrowserLoginPhase) => void,
	): Promise<void> {
		await openUrl(this.loginUrl);
		for (const phase of this.loginPhases) onPhase(phase);
	}
	setPollInterval(seconds: number): void {
		this.pollSeconds = seconds;
	}
	dispose(): void {
		this.disposed++;
	}
}

export class RecordingLogger implements AdapterLogger {
	readonly lines: string[] = [];
	debug(message: string): void {
		this.lines.push(`debug ${message}`);
	}
	info(message: string): void {
		this.lines.push(`info ${message}`);
	}
	warn(message: string): void {
		this.lines.push(`warn ${message}`);
	}
	error(message: string): void {
		this.lines.push(`error ${message}`);
	}
}

export class RecordingKeySurface implements KeySurface {
	readonly id: string;
	readonly images: Array<string | undefined> = [];
	readonly titles: Array<string | undefined> = [];
	readonly settingsWrites: ActionSettings[] = [];

	constructor(id = "key-1") {
		this.id = id;
	}
	alerts = 0;
	async setImage(image: string | undefined): Promise<void> {
		this.images.push(image);
	}
	async showAlert(): Promise<void> {
		this.alerts++;
	}
	async setTitle(title: string | undefined): Promise<void> {
		this.titles.push(title);
	}
	async setSettings(settings: ActionSettings): Promise<void> {
		this.settingsWrites.push(settings);
	}
	get lastTitle(): string | undefined {
		return this.titles.at(-1);
	}
	get lastImage(): string | undefined {
		return this.images.at(-1);
	}
}

export class RecordingDialSurface implements DialSurface {
	readonly id: string;
	readonly feedback: Array<DialFeedbackPayload | HistoryStripPayload> = [];
	readonly layouts: string[] = [];
	readonly settingsWrites: ActionSettings[] = [];

	constructor(id = "dial-1") {
		this.id = id;
	}
	async setFeedback(payload: DialFeedbackPayload | HistoryStripPayload): Promise<void> {
		this.feedback.push(payload);
	}
	async setFeedbackLayout(layout: string): Promise<void> {
		this.layouts.push(layout);
	}
	async setSettings(settings: ActionSettings): Promise<void> {
		this.settingsWrites.push(settings);
	}
	/** The newest `$B1` payload (the history strip has other items; see `lastStrip`). */
	get last(): DialFeedbackPayload | undefined {
		return this.feedback.filter((p): p is DialFeedbackPayload => "icon" in p).at(-1);
	}
	get lastStrip(): HistoryStripPayload | undefined {
		return this.feedback.filter((p): p is HistoryStripPayload => "chart" in p).at(-1);
	}
}

export function makeEnv(source: FakeSource | undefined, extra: Partial<ControllerEnv> & { global?: GlobalSettings } = {}): ControllerEnv & { logger: RecordingLogger } {
	const logger = new RecordingLogger();
	const global = extra.global ?? {};
	return {
		getSource: () => source as never,
		now: () => NOW,
		logger,
		getGlobal: () => global,
		waitForSettings: () => Promise.resolve(),
		onGlobalChange: () => () => {},
		getHistory: (request) => (source instanceof FakeService ? source.getHistory(request) : undefined),
		debounceMs: 5,
		...extra,
	} as ControllerEnv & { logger: RecordingLogger };
}

/** Let queued microtasks and short timers run. */
export function settle(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode the SVG out of a `data:image/svg+xml;base64,` URI. */
export function decodeSvg(uri: string | undefined): string {
	if (!uri) return "";
	return Buffer.from(uri.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");
}

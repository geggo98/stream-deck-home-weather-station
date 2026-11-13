/**
 * Property Inspector <-> plugin messages, SDK-free and testable with a fake service.
 *
 * The SDK action classes forward every `sendToPlugin` payload to `handle`; plugin.ts wires
 * the real service, `streamDeck.ui.sendToPropertyInspector` and `streamDeck.system.openUrl`
 * in. Event names and shapes come from src/pi-protocol.ts.
 *
 * Rules enforced here:
 *  - secrets travel PI -> plugin only, once, in `setCredentials` / `startBrowserLogin`;
 *    nothing here ever logs or echoes them;
 *  - every reply is a `PluginToPiMessage`: the closed union has no secret-carrying shape;
 *  - every datasource reply carries an `items` ARRAY (a reply without one blanks the
 *    dropdown in sdpi-components); status rides along as an extra field;
 *  - text that came from the API (station and module names, error texts) is cleaned and
 *    length-limited before it goes to the PI.
 */

import type { ActionSettings } from "../focus/settings.ts";
import type { AdapterLogger } from "../adapter/logging.ts";
import { parseCredentialInput, parseLoginInput } from "../adapter/station/credentials.ts";
import { defaultDataDir } from "../adapter/station/paths.ts";
import type { WeatherService } from "../adapter/station/service.ts";
import { UNPERSISTED_ROTATION_MESSAGE } from "../adapter/station/token-manager.ts";
import type { ModuleRole, StationSnapshot } from "../adapter/station/types.ts";
import {
	PI_EVENTS,
	type AccountStatus,
	type BrowserLoginMessage,
	type ClearResultMessage,
	type CredentialsResultMessage,
	type DatasourceItem,
	type DatasourceMessage,
	type GlobalSettings,
	type GlobalSettingsMessage,
	type PluginToPiMessage,
} from "../pi-protocol.ts";
import { DISPLAY_METRIC_IDS, HISTORY_METRIC, METRICS, metricsReportedBy, type DisplayMetricId } from "../render/metrics.ts";
import { adoptionCandidate, findModule, makeModuleKey } from "../render/select.ts";
import { cleanLabel } from "../render/title.ts";
import { MAX_POLL_SECONDS, MIN_POLL_SECONDS, pollIntervalOf, unitSystemOf } from "./global-settings.ts";

/** What the poller uses when the settings carry no interval. */
export const DEFAULT_POLL_SECONDS = 300;

/**
 * Longest credential field accepted from the PI; real values are well below this. A literal on
 * purpose: tests/pi-logic.test.ts reads it from this file and holds the PI's limit to it, and
 * tests/actions-pi-router-hardening.test.ts holds it to the adapter's MAX_FIELD_LENGTH.
 */
export const MAX_CREDENTIAL_CHARS = 512;
/** Longest error text forwarded to the PI. */
export const MAX_MESSAGE_CHARS = 300;

export interface PiRouterDeps {
	getService(): WeatherService | undefined;
	/** Send to the PI that is currently visible. */
	reply(message: PluginToPiMessage): Promise<void>;
	openUrl(url: string): Promise<void>;
	getActionSettings(actionId: string): ActionSettings | undefined;
	/** The metric the action id presets (the humidity key: "humidity"); lets the PI preselect it. */
	getActionDefaultMetric?(actionId: string): DisplayMetricId | undefined;
	/** True for the history key: its metric dropdown offers only measurements that have a history. */
	isHistoryAction?(actionId: string): boolean;
	getGlobal(): GlobalSettings;
	/** Why the global settings cannot be written this session (the load failed), or undefined. */
	getGlobalError?(): string | undefined;
	/** The settings write funnel. */
	updateGlobal(patch: (current: GlobalSettings) => GlobalSettings | undefined): Promise<void>;
	logger: AdapterLogger;
}

export interface PiRouter {
	/** Returns true when the payload was one of ours. */
	handle(actionId: string, payload: unknown): Promise<boolean>;
	/** Status as the PI shows it; also used by plugin.ts to push changes. */
	accountStatus(): Promise<AccountStatus>;
}

const ROLE_LABEL: Readonly<Record<ModuleRole, string>> = {
	"base": "base station",
	"outdoor": "outdoor",
	"wind": "wind",
	"rain": "rain",
	"indoor-extra": "indoor",
};

/** Shown when the credentials file exists but cannot be used (permissions, damaged content). */
export function unreadableCredentialsMessage(): string {
	return `The saved credentials cannot be read (permissions or a damaged file). Fix or delete credentials.json in ${credentialsLocation()}, then sign in again.`;
}

/** Shown when "Clear" could not remove the file: polling goes on, and the user knows where the file is. */
export function clearFailedMessage(): string {
	return `The saved credentials could not be removed, so the plugin keeps using them. Delete credentials.json in ${credentialsLocation()} by hand, then restart Stream Deck.`;
}

/** Shown after a refused or failed settings write whose cause is not a failed load. */
export const SETTINGS_WRITE_FAILED_MESSAGE = "The settings could not be saved. Try again; see the plugin log if it keeps failing.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialsLocation(): string {
	return defaultDataDir();
}

/** errno-style code (EACCES, ENOSPC) when there is one, else the error's class name; never a message (it may carry a path or a value). */
function errorCode(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
	return err instanceof Error ? err.name : "unknown";
}

/** Module dropdown items: a flat list for one station, grouped by station for several. */
export function moduleItems(snapshot: StationSnapshot | undefined): DatasourceItem[] {
	if (!snapshot) return [];
	const label = (name: string, role: ModuleRole): string => `${cleanLabel(name, 32) || "(unnamed)"} (${ROLE_LABEL[role]})`;
	if (snapshot.stations.length === 1) {
		const station = snapshot.stations[0]!;
		return station.modules.map((m) => ({ label: label(m.name, m.role), value: makeModuleKey(station.id, m.id) }));
	}
	return snapshot.stations.map((station) => ({
		label: cleanLabel(station.name, 32) || "(unnamed station)",
		children: station.modules.map((m) => ({ label: label(m.name, m.role), value: makeModuleKey(station.id, m.id) })),
	}));
}

/** Metric dropdown items for the module an action points at (all metrics when unknown). */
export function metricItems(snapshot: StationSnapshot | undefined, settings: Pick<ActionSettings, "moduleKey"> | undefined, options: { readonly historyOnly?: boolean } = {}): DatasourceItem[] {
	let ids = DISPLAY_METRIC_IDS;
	if (snapshot) {
		const selected =
			settings?.moduleKey === undefined ? adoptionCandidate(snapshot, "temperature") : findModule(snapshot, settings.moduleKey);
		if (selected) ids = metricsReportedBy(selected.module.values);
	}
	// The history key can only draw what getmeasure delivers: station pressure and gusts would end in "No history".
	if (options.historyOnly === true) ids = ids.filter((id) => HISTORY_METRIC[id] !== undefined);
	return ids.map((id) => ({ label: METRICS[id].label, value: id }));
}

export function createPiRouter(deps: PiRouterDeps): PiRouter {
	const reply = (message: PluginToPiMessage): void => {
		deps.reply(message).catch((err) => deps.logger.error(`reply to PI failed (${errorCode(err)})`));
	};

	async function accountStatus(): Promise<AccountStatus> {
		const service = deps.getService();
		if (!service) return { state: "error", message: "The weather service could not be started. See the plugin log." };
		const summary = await service.getCredentialSummary();
		const snapshot = service.getSnapshot();
		const connection = service.getConnectionState();
		const base: Pick<AccountStatus, "clientIdHint" | "lastUpdate" | "stationCount" | "moduleCount"> = {
			clientIdHint: summary.clientIdHint,
			lastUpdate: snapshot ? new Date(snapshot.fetchedAt).toISOString() : undefined,
			stationCount: snapshot?.stations.length,
			moduleCount: snapshot?.stations.reduce((sum, s) => sum + s.modules.length, 0),
		};
		// A file that exists but cannot be used is not "not set up": entering the values again is
		// not enough while the file is in the way, and the user needs to know where it is.
		if (summary.unreadable === true) return { state: "error", message: cleanLabel(unreadableCredentialsMessage(), MAX_MESSAGE_CHARS), ...base };
		if (!summary.configured || connection.kind === "no-credentials") return { state: "not-configured", ...base };
		switch (connection.kind) {
			case "loading":
				return { state: "loading", ...base };
			case "ok":
				// "The renewed sign-in could not be saved": data keeps flowing, so the account is fine
				// and the text rides along as a warning instead of turning the status red.
				return connection.warning === "unpersisted-rotation"
					? { state: "ok", warning: cleanLabel(UNPERSISTED_ROTATION_MESSAGE, MAX_MESSAGE_CHARS), ...base }
					: { state: "ok", ...base };
			case "error":
				return { state: "error", message: cleanLabel(connection.message, MAX_MESSAGE_CHARS), ...base };
			case "auth-error":
				return { state: "auth-error", message: cleanLabel(connection.message, MAX_MESSAGE_CHARS), ...base };
		}
	}

	async function replyStatus(): Promise<void> {
		const status = await accountStatus();
		// Both shapes: nested `status` like the other messages, and spread for a reader that
		// treats the message itself as the status.
		reply({ event: PI_EVENTS.accountStatus, status, ...status });
	}

	async function handleSetCredentials(message: Record<string, unknown>): Promise<void> {
		const service = deps.getService();
		// The adapter's one validation; its `error` is complete user-facing text.
		const parsed = parseCredentialInput(message);
		let ok = false;
		let error: string | undefined;
		let saved = false;
		if (!service) error = "The weather service is not running.";
		else if (!parsed.ok) error = cleanLabel(parsed.error, MAX_MESSAGE_CHARS);
		else {
			try {
				const result = await service.setCredentials(parsed.value);
				ok = result.ok;
				if (!result.ok) {
					// The service's text is complete and user-facing; it is only cleaned and cut here.
					error = cleanLabel(result.error, MAX_MESSAGE_CHARS);
					// Persisted but something after it failed: the PI must not ask for the
					// (already consumed) refresh token again.
					saved = result.saved === true;
				}
			} catch (err) {
				// The error object may carry anything; log only its class, show a fixed text.
				deps.logger.error(`setCredentials threw (${errorCode(err)})`);
				error = "Saving the credentials failed. See the plugin log.";
			}
		}
		const out: CredentialsResultMessage = {
			event: PI_EVENTS.credentialsResult,
			ok,
			...(saved ? { saved: true } : {}),
			error,
			status: await accountStatus(),
		};
		reply(out);
	}

	async function handleClear(): Promise<void> {
		const service = deps.getService();
		let ok = true;
		let error: string | undefined;
		if (!service) {
			ok = false;
			error = "The weather service is not running.";
		} else {
			try {
				await service.clearCredentials();
			} catch (err) {
				// The service rejects when the file could not be removed (and then keeps polling).
				deps.logger.error(`clearCredentials failed (${errorCode(err)})`);
				ok = false;
				error = clearFailedMessage();
			}
		}
		const out: ClearResultMessage = { event: PI_EVENTS.clearResult, ok, ...(error === undefined ? {} : { error }), status: await accountStatus() };
		reply(out);
	}

	async function handleBrowserLogin(message: Record<string, unknown>): Promise<void> {
		const service = deps.getService();
		// Same strict check as the paste route, BEFORE the browser opens: the authorization code is single use.
		const parsed = parseLoginInput(message);
		const send = (phase: BrowserLoginMessage["phase"], extra: Partial<BrowserLoginMessage> = {}): void => {
			const out: BrowserLoginMessage = { event: PI_EVENTS.browserLogin, phase, ...extra };
			reply(out);
		};
		if (!service) {
			send("error", { message: "The weather service is not running." });
			return;
		}
		if (!parsed.ok) {
			send("error", { message: cleanLabel(parsed.error, MAX_MESSAGE_CHARS) });
			return;
		}
		try {
			await service.startBrowserLogin(
				parsed.value,
				async (url) => {
					// Only https URLs leave the plugin; the adapter builds the authorisation URL.
					if (!/^https:\/\//i.test(url)) throw new Error("refusing to open a non-https URL");
					await deps.openUrl(url);
				},
				(phase) => {
					if (phase.phase === "waiting") send("waiting", { redirectUri: phase.redirectUri });
					else if (phase.phase === "error") send("error", { message: cleanLabel(phase.message, MAX_MESSAGE_CHARS) });
					else {
						// "done" is sent even when the status cannot be read: the PI must not sit on "Waiting".
						accountStatus().then(
							(status) => send("done", { status }),
							(err) => {
								deps.logger.warn(`status after browser sign-in failed (${errorCode(err)})`);
								send("done");
							},
						);
					}
				},
			);
		} catch (err) {
			deps.logger.error(`startBrowserLogin failed (${errorCode(err)})`);
			send("error", { message: "Starting the browser sign-in failed. See the plugin log." });
		}
	}

	function globalSnapshot(error?: string): GlobalSettingsMessage {
		const gs = deps.getGlobal();
		const problem = error ?? deps.getGlobalError?.();
		return {
			event: PI_EVENTS.globalSettings,
			pollIntervalSeconds: pollIntervalOf(gs) ?? DEFAULT_POLL_SECONDS,
			unitSystem: unitSystemOf(gs),
			...(problem === undefined ? {} : { error: problem }),
		};
	}

	/**
	 * `setGlobalSettings`: validate, clamp, persist through the single-writer funnel, tell
	 * the service about a new poll interval, and answer with what is now in effect (also
	 * after a refusal or a failed write, with `error` set, so the PI never shows a value that
	 * was not applied). The funnel takes a value that could not be written back out of the
	 * cache, so what is reported is what is in effect.
	 * Unknown or invalid fields are ignored, not errors: the PI sends only what changed.
	 */
	async function handleSetGlobal(message: Record<string, unknown>): Promise<void> {
		const poll = message.pollIntervalSeconds;
		const units = message.unitSystem;
		const before = pollIntervalOf(deps.getGlobal());
		let requested: number | undefined;
		let error: string | undefined;
		try {
			await deps.updateGlobal((current) => {
				const next: GlobalSettings = { ...current };
				if (typeof poll === "number" && Number.isFinite(poll)) {
					next.pollIntervalSeconds = Math.max(MIN_POLL_SECONDS, Math.min(MAX_POLL_SECONDS, Math.round(poll)));
				}
				if (units === "account" || units === "metric" || units === "imperial") next.unitSystem = units;
				requested = pollIntervalOf(next);
				return JSON.stringify(next) === JSON.stringify(current) ? undefined : next;
			});
			// Only after the write went through: a refused or failed write must not change the schedule.
			if (requested !== undefined && requested !== before) deps.getService()?.setPollInterval(requested);
		} catch (err) {
			deps.logger.error(`global settings write failed (${errorCode(err)}): ${err instanceof Error ? err.message : String(err)}`);
			error = deps.getGlobalError?.() ?? SETTINGS_WRITE_FAILED_MESSAGE;
		}
		reply(globalSnapshot(error));
	}

	return {
		accountStatus,
		async handle(actionId, payload) {
			if (!isRecord(payload) || typeof payload.event !== "string") return false;
			const service = deps.getService();
			switch (payload.event) {
				case PI_EVENTS.getAccountStatus:
					await replyStatus();
					return true;
				case PI_EVENTS.setCredentials:
					await handleSetCredentials(payload);
					return true;
				case PI_EVENTS.clearCredentials:
					await handleClear();
					return true;
				case PI_EVENTS.refreshNow:
					try {
						await service?.refresh();
					} catch (err) {
						deps.logger.warn(`refresh from PI failed (${errorCode(err)})`);
					}
					await replyStatus();
					return true;
				case PI_EVENTS.startBrowserLogin:
					await handleBrowserLogin(payload);
					return true;
				case PI_EVENTS.getModules: {
					const message: DatasourceMessage = {
						event: PI_EVENTS.getModules,
						items: moduleItems(service?.getSnapshot()),
						status: await accountStatus(),
					};
					reply(message);
					return true;
				}
				case PI_EVENTS.getMetrics: {
					const message: DatasourceMessage = {
						event: PI_EVENTS.getMetrics,
						items: metricItems(service?.getSnapshot(), deps.getActionSettings(actionId), { historyOnly: deps.isHistoryAction?.(actionId) === true }),
						status: await accountStatus(),
					};
					// `defaultValue`: the action's preset metric, only when the module offers it (a dropdown
					// cannot preselect an option it does not have).
					const preset = deps.getActionDefaultMetric?.(actionId);
					const offered = preset !== undefined && message.items.some((item) => item.value === preset);
					reply({ ...message, ...(offered ? { defaultValue: preset } : {}) });
					return true;
				}
				case PI_EVENTS.getGlobalSettings:
					reply(globalSnapshot());
					return true;
				case PI_EVENTS.setGlobalSettings:
					await handleSetGlobal(payload);
					return true;
				default:
					return false;
			}
		},
	};
}

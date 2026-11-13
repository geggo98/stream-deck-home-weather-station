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
 *  - every datasource reply carries an `items` ARRAY (a reply without one blanks the
 *    dropdown in sdpi-components); status rides along as an extra field;
 *  - text that came from the API (station and module names, error texts) is cleaned and
 *    length-limited before it goes to the PI.
 */

import type { AdapterLogger } from "../adapter/logging.ts";
import type { WeatherService } from "../adapter/station/service.ts";
import type { ModuleRole, StationSnapshot } from "../adapter/station/types.ts";
import {
	PI_EVENTS,
	type AccountStatus,
	type BrowserLoginMessage,
	type CredentialsResultMessage,
	type DatasourceItem,
	type DatasourceMessage,
	type GlobalSettings,
	type GlobalSettingsMessage,
	type MeasurementSettings,
} from "../pi-protocol.ts";
import { DISPLAY_METRIC_IDS, METRICS, metricsReportedBy } from "../render/metrics.ts";
import { adoptionCandidate, findModule, makeModuleKey } from "../render/select.ts";
import { isUnpersistedRotation } from "../render/status.ts";
import { cleanLabel } from "../render/title.ts";
import { MAX_POLL_SECONDS, MIN_POLL_SECONDS, pollIntervalOf, unitSystemOf } from "./global-settings.ts";

/** Longest credential field accepted from the PI; real values are well below this. */
/** What the poller uses when the settings carry no interval. */
export const DEFAULT_POLL_SECONDS = 300;

export const MAX_CREDENTIAL_CHARS = 512;
/** Longest error text forwarded to the PI. */
export const MAX_MESSAGE_CHARS = 300;

export interface PiRouterDeps {
	getService(): WeatherService | undefined;
	/** Send to the PI that is currently visible. */
	reply(payload: Record<string, unknown>): Promise<void>;
	openUrl(url: string): Promise<void>;
	getActionSettings(actionId: string): MeasurementSettings | undefined;
	/** The metric the action id presets (the humidity key: "humidity"); lets the PI preselect it. */
	getActionDefaultMetric?(actionId: string): string | undefined;
	getGlobal(): GlobalSettings;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= MAX_CREDENTIAL_CHARS ? trimmed : undefined;
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
export function metricItems(snapshot: StationSnapshot | undefined, settings: MeasurementSettings | undefined): DatasourceItem[] {
	let ids = DISPLAY_METRIC_IDS;
	if (snapshot) {
		const selected =
			settings?.moduleKey === undefined ? adoptionCandidate(snapshot, "temperature") : findModule(snapshot, settings.moduleKey);
		if (selected) ids = metricsReportedBy(selected.module.values);
	}
	return ids.map((id) => ({ label: METRICS[id].label, value: id }));
}

export function createPiRouter(deps: PiRouterDeps): PiRouter {
	const reply = (payload: Record<string, unknown>): void => {
		deps.reply(payload).catch((err) => deps.logger.error(`reply to PI failed: ${err instanceof Error ? err.message : String(err)}`));
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
		if (!summary.configured || connection.kind === "no-credentials") return { state: "not-configured", ...base };
		switch (connection.kind) {
			case "loading":
				return { state: "loading", ...base };
			case "ok":
				return { state: "ok", ...base };
			case "error":
				// "The renewed sign-in could not be saved": data keeps flowing, so the account is fine
				// and the text rides along as a warning instead of turning the status red.
				if (isUnpersistedRotation(connection)) return { state: "ok", message: cleanLabel(connection.message, MAX_MESSAGE_CHARS), ...base };
				return { state: "error", message: cleanLabel(connection.message, MAX_MESSAGE_CHARS), ...base };
			case "auth-error":
				return { state: "auth-error", message: cleanLabel(connection.message, MAX_MESSAGE_CHARS), ...base };
		}
	}

	async function replyStatus(): Promise<void> {
		const status = await accountStatus();
		// Both shapes: nested `status` like the other messages, and spread for a reader that
		// treats the message itself as the status (pi-protocol.ts has no wrapper type for it).
		reply({ event: PI_EVENTS.accountStatus, status, ...status });
	}

	async function handleSetCredentials(message: Record<string, unknown>): Promise<void> {
		const service = deps.getService();
		const clientId = credentialField(message.clientId);
		const clientSecret = credentialField(message.clientSecret);
		const refreshToken = credentialField(message.refreshToken);
		let ok = false;
		let error: string | undefined;
		let saved = false;
		if (!service) error = "The weather service is not running.";
		else if (!clientId || !clientSecret || !refreshToken) error = "Client id, client secret and refresh token are all required.";
		else {
			try {
				const result = await service.setCredentials({ clientId, clientSecret, refreshToken });
				ok = result.ok;
				if (!result.ok) {
					error = cleanLabel(result.error, MAX_MESSAGE_CHARS);
					// Persisted but the first data load failed: the PI must not ask for the
					// (already consumed) refresh token again.
					saved = result.saved === true;
				}
			} catch (err) {
				// The error object may carry anything; log only that it failed, show a fixed text.
				deps.logger.error(`setCredentials threw (${err instanceof Error ? err.name : "unknown"})`);
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
		reply({ ...out });
	}

	async function handleBrowserLogin(message: Record<string, unknown>): Promise<void> {
		const service = deps.getService();
		const clientId = credentialField(message.clientId);
		const clientSecret = credentialField(message.clientSecret);
		const send = async (phase: BrowserLoginMessage["phase"], extra: Partial<BrowserLoginMessage> = {}): Promise<void> => {
			const out: BrowserLoginMessage = { event: PI_EVENTS.browserLogin, phase, ...extra };
			reply({ ...out });
		};
		if (!service || !clientId || !clientSecret) {
			await send("error", { message: !service ? "The weather service is not running." : "Client id and client secret are required." });
			return;
		}
		try {
			await service.startBrowserLogin(
				{ clientId, clientSecret },
				async (url) => {
					// Only https URLs leave the plugin; the adapter builds the authorisation URL.
					if (!/^https:\/\//i.test(url)) throw new Error("refusing to open a non-https URL");
					await deps.openUrl(url);
				},
				(phase) => {
					if (phase.phase === "waiting") void send("waiting", { redirectUri: phase.redirectUri });
					else if (phase.phase === "error") void send("error", { message: cleanLabel(phase.message, MAX_MESSAGE_CHARS) });
					else void accountStatus().then((status) => send("done", { status }));
				},
			);
		} catch (err) {
			deps.logger.error(`startBrowserLogin failed (${err instanceof Error ? err.name : "unknown"})`);
			await send("error", { message: "Starting the browser sign-in failed. See the plugin log." });
		}
	}

	function globalSnapshot(): GlobalSettingsMessage {
		const gs = deps.getGlobal();
		return { event: PI_EVENTS.globalSettings, pollIntervalSeconds: pollIntervalOf(gs) ?? DEFAULT_POLL_SECONDS, unitSystem: unitSystemOf(gs) };
	}

	/**
	 * `setGlobalSettings`: validate, clamp, persist through the single-writer funnel, tell
	 * the service about a new poll interval, and answer with what is now in effect (also
	 * after a refusal, so the PI never shows a value that was not applied).
	 * Unknown or invalid fields are ignored, not errors: the PI sends only what changed.
	 */
	async function handleSetGlobal(message: Record<string, unknown>): Promise<void> {
		const poll = message.pollIntervalSeconds;
		const units = message.unitSystem;
		const before = pollIntervalOf(deps.getGlobal());
		let requested: number | undefined;
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
			// Only after the write went through: a refused write must not change the schedule.
			if (requested !== undefined && requested !== before) deps.getService()?.setPollInterval(requested);
		} catch (err) {
			deps.logger.error(`global settings write failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		reply({ ...globalSnapshot() });
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
					try {
						await service?.clearCredentials();
					} catch (err) {
						deps.logger.error(`clearCredentials failed (${err instanceof Error ? err.name : "unknown"})`);
					}
					await replyStatus();
					return true;
				case PI_EVENTS.refreshNow:
					try {
						await service?.refresh();
					} catch (err) {
						deps.logger.warn(`refresh from PI failed (${err instanceof Error ? err.name : "unknown"})`);
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
					reply({ ...message });
					return true;
				}
				case PI_EVENTS.getMetrics: {
					const message: DatasourceMessage = {
						event: PI_EVENTS.getMetrics,
						items: metricItems(service?.getSnapshot(), deps.getActionSettings(actionId)),
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
					reply({ ...globalSnapshot() });
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

/**
 * Messages between the Property Inspector (ui/*.html, ui/init/*.js) and the
 * plugin process. SDK-free and dependency-free so both sides and the tests can
 * import it. The PI cannot import TypeScript, so ui/home-weather-pi.js repeats the event
 * names as string literals; tests/pi-logic.test.ts keeps both in sync.
 *
 * Rules (see docs/ARCHITECTURE.md):
 *  - Secrets (client secret, refresh token) travel PI -> plugin only, once per attempt,
 *    in `setCredentials` (id, secret, refresh token) or `startBrowserLogin` (id, secret).
 *    They are never sent back, never stored in Stream Deck settings and never logged by
 *    the plugin (at TRACE level the SDK itself logs every frame: SECURITY.md).
 *  - Every reply carries `event` so the PI can route it.
 */

export const PI_EVENTS = {
	// PI -> plugin
	getAccountStatus: "getAccountStatus",
	setCredentials: "setCredentials",
	clearCredentials: "clearCredentials",
	refreshNow: "refreshNow",
	startBrowserLogin: "startBrowserLogin",
	getGlobalSettings: "getGlobalSettings",
	setGlobalSettings: "setGlobalSettings",
	/** sdpi datasource requests; the reply has the same event name. */
	getModules: "getModules",
	getMetrics: "getMetrics",
	// plugin -> PI
	accountStatus: "accountStatus",
	credentialsResult: "credentialsResult",
	clearResult: "clearResult",
	browserLogin: "browserLogin",
	globalSettings: "globalSettings",
} as const;

export type PiEvent = (typeof PI_EVENTS)[keyof typeof PI_EVENTS];

export type AccountState = "not-configured" | "loading" | "ok" | "error" | "auth-error";

export interface AccountStatus {
	readonly state: AccountState;
	/** Short human-readable explanation, safe to show (never contains secrets or raw API bodies). */
	readonly message?: string;
	readonly clientIdHint?: string;
	/** ISO-8601 time of the newest snapshot, if any. */
	readonly lastUpdate?: string;
	readonly stationCount?: number;
	readonly moduleCount?: number;
	/** state "ok" with a warning: data is current, but something needs attention (e.g. the renewed sign-in could not be saved). Shown by the PI in warning colour. */
	readonly warning?: string;
}

export interface SetCredentialsMessage {
	readonly event: typeof PI_EVENTS.setCredentials;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly refreshToken: string;
}

export interface StartBrowserLoginMessage {
	readonly event: typeof PI_EVENTS.startBrowserLogin;
	readonly clientId: string;
	readonly clientSecret: string;
}

export interface CredentialsResultMessage {
	readonly event: typeof PI_EVENTS.credentialsResult;
	readonly ok: boolean;
	/** ok:false with saved:true = persisted, but the first data load failed; polling retries by itself. */
	readonly saved?: boolean;
	readonly error?: string;
	readonly status: AccountStatus;
}

/** plugin -> PI: result of `clearCredentials`. ok:false means the stored file could NOT be removed. */
export interface ClearResultMessage {
	readonly event: typeof PI_EVENTS.clearResult;
	readonly ok: boolean;
	readonly error?: string;
	readonly status: AccountStatus;
}

/** PI -> plugin: change plugin-wide settings (validated and clamped by the plugin). Reply: `globalSettings`. */
export interface SetGlobalSettingsMessage {
	readonly event: typeof PI_EVENTS.setGlobalSettings;
	readonly pollIntervalSeconds?: number;
	readonly unitSystem?: "account" | "metric" | "imperial";
}

/** plugin -> PI: current plugin-wide settings, sent on getGlobalSettings and after every change. */
export interface GlobalSettingsMessage {
	readonly event: typeof PI_EVENTS.globalSettings;
	readonly pollIntervalSeconds: number;
	readonly unitSystem: "account" | "metric" | "imperial";
	/** Set when a requested change could not be saved (settings never loaded, write failed); the values above are then the ones still in effect. */
	readonly error?: string;
}

export interface BrowserLoginMessage {
	readonly event: typeof PI_EVENTS.browserLogin;
	readonly phase: "waiting" | "done" | "error";
	/** The redirect URI the user must have registered in their Netatmo app (shown in the PI). */
	readonly redirectUri?: string;
	readonly message?: string;
	readonly status?: AccountStatus;
}

/** sdpi-components datasource item: flat or grouped. */
export interface DatasourceItem {
	readonly label: string;
	readonly value?: string;
	readonly children?: readonly DatasourceItem[];
	readonly disabled?: boolean;
}

export interface DatasourceMessage {
	readonly event: typeof PI_EVENTS.getModules | typeof PI_EVENTS.getMetrics;
	/** A reply WITHOUT items blanks the dropdown in sdpi-components; always send an array. */
	readonly items: readonly DatasourceItem[];
	/** Value to preselect when the action's setting is unset (the action's preset metric); only sent when the module offers it. */
	readonly defaultValue?: string;
	readonly status?: AccountStatus;
}

/** Per-action settings (stored by Stream Deck, plain JSON, no secrets). */
export interface MeasurementSettings {
	/** "<stationId>|<moduleId>" chosen in the PI; absent (undefined) = adopt a module that reports the key's measurement on first use; "" = deliberately cleared, the key then shows "Pick module". */
	moduleKey?: string;
	metric?: string;
	/** "auto" = follow the Netatmo account's unit preferences. */
	unitSystem?: "auto" | "metric" | "imperial";
	showTrend?: boolean;
	showMinMax?: boolean;
	/** Draw the value as SVG text instead of the native key title. Experimental: not verified on hardware. */
	bigText?: boolean;
	/** Optional user label overriding the module name. */
	label?: string;
	/** true = behave like the focus display: follow the plugin-wide focus (station, sensor, value). */
	followFocus?: boolean;
	/** Alert thresholds in the key's DISPLAY unit; empty/undefined = off. */
	alertAbove?: number;
	alertBelow?: number;
	/** History key: time window. */
	historyWindow?: "6h" | "24h" | "3d";
	/** Auto-rotate key: seconds between steps (3..60) and whether it starts switched on. */
	autoRotateSeconds?: number;
	autoRotateStartOn?: boolean;
}

/** Plugin-wide settings (Stream Deck global settings, plain JSON, no secrets). */
export interface GlobalSettings {
	pollIntervalSeconds?: number;
	unitSystem?: "account" | "metric" | "imperial";
	[key: string]: unknown;
}

/** plugin -> PI: the closed set of messages the plugin may send. A secret-carrying shape does not belong to it. */
export interface AccountStatusMessage {
	readonly event: typeof PI_EVENTS.accountStatus;
	readonly status: AccountStatus;
}

export type PluginToPiMessage =
	| AccountStatusMessage
	| CredentialsResultMessage
	| ClearResultMessage
	| BrowserLoginMessage
	| GlobalSettingsMessage
	| DatasourceMessage;

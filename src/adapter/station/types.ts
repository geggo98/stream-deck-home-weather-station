/**
 * Normalised data model of the Netatmo adapter.
 *
 * This file is the contract between the SDK-free adapter (src/adapter/station/*)
 * and everything that consumes it (poller subscribers, actions, renderers). The
 * adapter must never import `@elgato/streamdeck` (see docs/ARCHITECTURE.md).
 *
 * Source of truth for the wire format: the weather-station section of the
 * Netatmo Connect API (getstationsdata). The API always delivers metric values;
 * unit preferences travel separately in `UnitPreferences` and are applied only
 * when formatting (src/render/format.ts, the one live unit implementation).
 */

/** Raw module type codes as sent by the API (weather station family only). */
export type ModuleType = "NAMain" | "NAModule1" | "NAModule2" | "NAModule3" | "NAModule4";

/** Human meaning of a module type. NAMain is the indoor base station. */
export type ModuleRole = "base" | "outdoor" | "wind" | "rain" | "indoor-extra";

/**
 * Every measurement the plugin can show. Values are stored in the API's native
 * (metric) unit:
 *   temperature, tempMin, tempMax  °C
 *   humidity                       %
 *   co2                            ppm
 *   noise                          dB
 *   pressure, absolutePressure     mbar (hPa)
 *   rain, rain1h, rain24h          mm
 *   windStrength, gustStrength     km/h
 *   windAngle, gustAngle           degrees (0..360)
 *   tempTrend, pressureTrend       "up" | "down" | "stable" (kept as a number: +1, -1, 0)
 */
export type MetricKey =
	| "temperature"
	| "humidity"
	| "co2"
	| "noise"
	| "pressure"
	| "absolutePressure"
	| "rain"
	| "rain1h"
	| "rain24h"
	| "windStrength"
	| "windAngle"
	| "gustStrength"
	| "gustAngle"
	| "tempMin"
	| "tempMax"
	| "tempTrend"
	| "pressureTrend";

export type MetricValues = Partial<Record<MetricKey, number>>;

export interface ModuleData {
	/** Stable id (the module's MAC address as delivered by the API). Treat as sensitive: never log at INFO. */
	readonly id: string;
	readonly type: ModuleType;
	readonly role: ModuleRole;
	/** User-chosen module name from the Netatmo account; untrusted text, never interpolate into markup. */
	readonly name: string;
	/** `reachable` from the API: connected within the last ~4 hours. NOT a freshness signal. */
	readonly reachable: boolean;
	/** Epoch milliseconds of the newest measurement (dashboard_data.time_utc * 1000), null if absent. */
	readonly measuredAt: number | null;
	/** Battery level in percent when the API reports it (outdoor/wind/rain/extra modules). */
	readonly batteryPercent?: number;
	readonly values: MetricValues;
}

export interface StationData {
	readonly id: string;
	readonly name: string;
	/** modules[0] is always the base station; the others follow in API order. */
	readonly modules: readonly ModuleData[];
}

/** Unit preferences of the Netatmo account (body.user.administrative). Display only. */
export interface UnitPreferences {
	/** The account's unit system (the API sends 0 = metric, 1 = imperial; parse.ts maps it). */
	readonly unitSystem: "metric" | "imperial";
	readonly windUnit: "kmh" | "mph" | "ms" | "beaufort" | "knots";
	readonly pressureUnit: "mbar" | "inhg" | "mmhg";
	/** Locale string of the account, e.g. "de-DE"; optional, display hint only. */
	readonly locale?: string;
}

export interface StationSnapshot {
	/** Epoch milliseconds when WE received this snapshot. */
	readonly fetchedAt: number;
	readonly stations: readonly StationData[];
	readonly preferences: UnitPreferences;
}

/**
 * Why the plugin currently cannot show fresh data. Computed by the poller from
 * errors and the time of the last fetch; the renderers display it as a pure function of this
 * value (see docs/ARCHITECTURE.md, "Status is a pure function").
 */
export type ConnectionState =
	| { readonly kind: "no-credentials" }
	| { readonly kind: "loading" }
	/** Data is current. `warning` is set while the renewed sign-in could not be persisted (the plugin keeps working, but a restart would need a new sign-in); it never dims data. */
	| { readonly kind: "ok"; readonly warning?: "unpersisted-rotation" }
	/** Last poll failed transiently (network, 5xx, 429); cached data is still shown, but dimmed at once (a single failed poll marks every key stale; there is no grace period, see src/render/status.ts). */
	| { readonly kind: "error"; readonly message: string; readonly since: number; readonly retryAt: number }
	/** The refresh token was rejected or revoked; the user must sign in again. Polling stops until credentials change. */
	| { readonly kind: "auth-error"; readonly message: string; readonly since: number };

/** Freshness of a single module's data, derived from `measuredAt`, `reachable` and the clock. */
export type Freshness = "fresh" | "stale" | "unreachable" | "unknown";

export interface PollerSubscription {
	unsubscribe(): void;
}

/** Public surface the plugin layer uses. Implemented in src/adapter/station/poller.ts. */
export interface WeatherSource {
	/** Latest snapshot or undefined before the first successful poll. Never triggers I/O. */
	getSnapshot(): StationSnapshot | undefined;
	getConnectionState(): ConnectionState;
	/** Called on every snapshot or connection-state change. Starts polling on the first subscriber, stops after the last. */
	subscribe(listener: () => void): PollerSubscription;
	/** Asks for an immediate poll; coalesced and rate-limited (min. 60 s between real requests). Resolves when the poll finished. */
	refresh(): Promise<void>;
	/** Re-reads credentials (after the PI saved or cleared them) and restarts polling. */
	credentialsChanged(): Promise<void>;
}

/** Subset of credentials the PI is allowed to know about. The values themselves never leave the plugin process. */
export interface CredentialSummary {
	readonly configured: boolean;
	/** true when a credentials file exists but cannot be read or is corrupt (permissions, damaged JSON): different from "not set up". */
	readonly unreadable?: boolean;
	/** Last 4 characters of the client id, to let the user recognise which app is in use. */
	readonly clientIdHint?: string;
}

/** Time window of the history key. */
export type HistoryWindow = "6h" | "24h" | "3d";

/** Metrics for which Netatmo's getmeasure can deliver a series (the display metrics Station pressure and Gusts have none). */
export type HistoryMetric = "temperature" | "humidity" | "co2" | "noise" | "pressure" | "rain" | "windStrength";

export interface HistoryRequest {
	readonly stationId: string;
	readonly moduleId: string;
	readonly metric: HistoryMetric;
	readonly window: HistoryWindow;
}

export interface HistoryPoint {
	/**
	 * Epoch milliseconds exactly as the API reports it. With real_time=false the OpenAPI spec
	 * documents this as the MIDDLE of the bucket ("offset + scale/2"; UNVERIFIED live, see
	 * docs/WEATHER-API.md). A consumer must treat the bucket as [t - stepMs/2, t + stepMs/2),
	 * so the newest point may lie up to stepMs/2 after the request's end time.
	 */
	readonly t: number;
	/** Native (metric) unit, like MetricValues. For rain: mm per bucket (sum). */
	readonly v: number;
}

export type HistoryResult =
	| {
			readonly kind: "ok";
			readonly request: HistoryRequest;
			readonly points: readonly HistoryPoint[];
			/** Bucket length in ms (step_time); lets the renderer detect gaps. */
			readonly stepMs: number;
			readonly fetchedAt: number;
	  }
	| {
			readonly kind: "error";
			readonly request: HistoryRequest;
			/** Short, safe-to-display text (no secrets, no raw bodies). */
			readonly message: string;
			/** auth: the user must sign in again; rate: budget exhausted, retry later; transient: network/5xx; unsupported: this module/metric has no history. */
			readonly reason: "auth" | "rate" | "transient" | "unsupported";
	  };

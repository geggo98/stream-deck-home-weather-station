/**
 * The one object the plugin layer talks to. Implemented by `createWeatherService`
 * (create-service.ts); faked in action tests. SDK-free.
 */

import type { AdapterLogger } from "../logging.ts";
import type { CredentialSummary, HistoryRequest, HistoryResult, StationSnapshot, WeatherSource } from "./types.ts";

export interface CredentialInput {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly refreshToken: string;
}

export type SetCredentialsResult =
	| { readonly ok: true; readonly snapshot: StationSnapshot }
	| {
			readonly ok: false;
			readonly error: string;
			/** true when the credentials WERE persisted (the refresh succeeded and consumed the pasted token) but loading station data failed; the PI must not ask the user to enter them again. */
			readonly saved?: boolean;
	  };

export type BrowserLoginPhase =
	| { readonly phase: "waiting"; readonly redirectUri: string }
	| { readonly phase: "done" }
	| { readonly phase: "error"; readonly message: string };

export interface WeatherService extends WeatherSource {
	getCredentialSummary(): Promise<CredentialSummary>;
	/**
	 * Validate by doing one real token refresh + getstationsdata with the given values.
	 * Only on success are they persisted (atomically, 0600) and polling restarted.
	 * The error text is safe to show in the PI: no secrets, no raw API bodies.
	 */
	setCredentials(input: CredentialInput): Promise<SetCredentialsResult>;
	clearCredentials(): Promise<void>;
	/**
	 * Experimental authorization-code flow with a loopback redirect. `openUrl` opens the
	 * system browser (plugin layer passes `streamDeck.system.openUrl`). `onPhase` is called
	 * for waiting / done / error; the listener closes after the first callback or 3 minutes.
	 */
	startBrowserLogin(
		input: { readonly clientId: string; readonly clientSecret: string },
		openUrl: (url: string) => Promise<void>,
		onPhase: (phase: BrowserLoginPhase) => void,
	): Promise<void>;
	/**
	 * Time series for the history key. Cached per (module, metric, window) for 10 minutes,
	 * concurrent identical requests share one HTTP call, at most one real request per key
	 * combination per 30 s, shares the client's rate budget and token manager. Never throws:
	 * errors come back as `kind: "error"`. Never called for invisible actions (the plugin layer decides).
	 */
	getHistory(request: HistoryRequest): Promise<HistoryResult>;
	/** Seconds between polls; clamped to 60..3600. */
	setPollInterval(seconds: number): void;
	/** Stops timers and closes listeners. Idempotent. */
	dispose(): void;
}

export interface WeatherServiceOptions {
	readonly logger?: AdapterLogger;
	/** Directory for credentials.json. Default: per-user application-data dir (see docs/ARCHITECTURE.md). */
	readonly dataDir?: string;
	/** Injectable for tests. */
	readonly fetchImpl?: typeof fetch;
	/** Default https://api.netatmo.com ; tests point it at a local http double. */
	readonly baseUrl?: string;
	readonly now?: () => number;
	/** 0..1, for jitter; tests pass a constant. */
	readonly random?: () => number;
	readonly pollIntervalSeconds?: number;
	/** Port of the loopback redirect for startBrowserLogin. Default 53682. */
	readonly loopbackPort?: number;
}

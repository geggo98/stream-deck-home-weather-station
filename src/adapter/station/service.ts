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

/** Client ID and secret of the browser sign-in (there is no refresh token yet). */
export interface LoginInput {
	readonly clientId: string;
	readonly clientSecret: string;
}

export type SetCredentialsResult =
	| { readonly ok: true; readonly snapshot: StationSnapshot }
	| {
			readonly ok: false;
			/** Complete, user-facing text: safe to show as given (no secrets, no raw bodies), already says what to do next. */
			readonly error: string;
			/**
			 * true when the refresh succeeded, which consumed the pasted refresh token (Netatmo
			 * invalidates it at once). The rotated pair is then in use, and either written to disk
			 * (`saved: true`) or held in memory only while the write is retried (`saved: false`:
			 * disk full or not writable). Absent = nothing was changed, entering the same values again is fine.
			 */
			readonly saved?: boolean;
	  };

/**
 * `clearCredentials` could not remove the credentials file (permissions, locked, read-only
 * disk). `message` is complete user-facing text and names the file, so the user can delete
 * it by hand; `code` is the errno class (for example EACCES), `path` the file.
 */
export class ClearCredentialsError extends Error {
	readonly code: string;
	readonly path: string;

	constructor(code: string, path: string) {
		super(`The stored credentials could not be removed (${code}). Polling continues with them. Delete the file ${path} by hand, then press Clear again.`);
		this.name = "ClearCredentialsError";
		this.code = code;
		this.path = path;
	}
}

export type BrowserLoginPhase =
	| { readonly phase: "waiting"; readonly redirectUri: string }
	| { readonly phase: "done" }
	| { readonly phase: "error"; readonly message: string };

export interface WeatherService extends WeatherSource {
	getCredentialSummary(): Promise<CredentialSummary>;
	/**
	 * Path of the credentials file (for messages that tell the user where to look); undefined
	 * for services that keep nothing on disk (test doubles).
	 */
	readonly credentialsLocation?: string;
	/**
	 * Validate with one real token refresh, then one getstationsdata, using the given values.
	 * Because the refresh token ROTATES, the rotated pair is written to disk as soon as the
	 * REFRESH succeeds, even when the data request after it fails (`saved: true`); only a
	 * rejected or failed refresh writes nothing. Input that fails `parseCredentialInput` is
	 * refused before any request. The error text is safe to show in the PI: no secrets, no raw API bodies.
	 */
	setCredentials(input: CredentialInput): Promise<SetCredentialsResult>;
	/**
	 * Removes the stored credentials and stops polling. REJECTS with `ClearCredentialsError` when
	 * the file cannot be removed; polling then continues with the credentials still in place.
	 */
	clearCredentials(): Promise<void>;
	/**
	 * Experimental authorization-code flow with a loopback redirect. `openUrl` opens the
	 * system browser (plugin layer passes `streamDeck.system.openUrl`). `onPhase` is called
	 * for waiting / done / error; the listener closes after the first callback or 3 minutes.
	 * Client ID and secret are checked first (`parseLoginInput`): a bad value ends in an `error` phase
	 * before the browser opens, not after the single-use authorization code was spent.
	 */
	startBrowserLogin(
		input: LoginInput,
		openUrl: (url: string) => Promise<void>,
		onPhase: (phase: BrowserLoginPhase) => void,
	): Promise<void>;
	/**
	 * Time series for the history key. Cached per (station, module, metric, window) for 10 minutes,
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

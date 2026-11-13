/**
 * Wires credentials, token manager, client and poller into the WeatherService declared in
 * service.ts. SDK-free.
 *
 * `setCredentials` validates through the SAME code path as normal polling (TokenManager +
 * NetatmoClient) but against a staging store, so a wrong pasted token can never clobber
 * working credentials. One subtlety, because refresh tokens rotate: validation consumes the
 * pasted refresh token. Once the refresh succeeded the rotated pair is the ONLY valid one,
 * so it is persisted even if the following getstationsdata request fails (then the result is
 * `ok: false, saved: true` with an explanation; polling retries by itself unless the failure is
 * an auth error, which stops it like any other). If the refresh itself is rejected or fails,
 * nothing is written. If the WRITE fails, the rotated pair is adopted into the live token
 * manager (in memory, flagged `unpersisted-rotation`, written again on every poll) and the
 * result is `ok: false, saved: false`.
 */

import { type AdapterLogger, scopedLogger } from "../logging.ts";
import { type BrowserLoginHandle, DEFAULT_LOOPBACK_PORT, startBrowserLogin } from "./browser-login.ts";
import {
	type CredentialStore,
	FileCredentialStore,
	MemoryCredentialStore,
	type StoredCredentials,
	parseCredentialInput,
	parseLoginInput,
} from "./credentials.ts";
import { RequestBudget } from "./budget.ts";
import { NetatmoClient } from "./client.ts";
import { describeUnexpected, toNetatmoError } from "./errors.ts";
import { HistoryService } from "./history.ts";
import { Poller } from "./poller.ts";
import { SecretRegistry, redactingLogger } from "./redact.ts";
import {
	type BrowserLoginPhase,
	ClearCredentialsError,
	type CredentialInput,
	type SetCredentialsResult,
	type WeatherService,
	type WeatherServiceOptions,
} from "./service.ts";
import { DEFAULT_BASE_URL, TokenManager } from "./token-manager.ts";
import type { CredentialSummary, HistoryRequest, HistoryResult, StationSnapshot } from "./types.ts";

function prefixed(base: AdapterLogger, scope: string): AdapterLogger {
	const p = (m: string) => `${scope}: ${m}`;
	return {
		debug: (m) => base.debug(p(m)),
		info: (m) => base.info(p(m)),
		warn: (m) => base.warn(p(m)),
		error: (m) => base.error(p(m)),
	};
}

/** Errno class of a failed file operation ("EACCES"), or "error"; never the message (it holds paths). */
function errnoOf(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && /^[A-Z0-9_]{2,20}$/.test(code) ? code : "error";
}

/** Plain words for the errno classes a user can act on. */
function writeFailureCause(code: string): string {
	if (code === "ENOSPC" || code === "EDQUOT") return "the disk is full";
	if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "the folder is not writable";
	return "the write failed";
}

/**
 * Remembers every secret that passes through the store so the logger can mask it (the
 * registry keeps the current and the previous generation only).
 * Exported for tests only.
 */
export class TrackingStore implements CredentialStore {
	private readonly secrets: SecretRegistry;
	private readonly inner: CredentialStore;

	constructor(inner: CredentialStore, secrets: SecretRegistry) {
		this.inner = inner;
		this.secrets = secrets;
	}

	track(c: StoredCredentials | undefined): void {
		if (!c) return;
		this.secrets.add([c.clientSecret, c.refreshToken, c.accessToken]);
	}

	async load(): Promise<StoredCredentials | undefined> {
		const c = await this.inner.load();
		this.track(c);
		return c;
	}

	async probe(): Promise<{ readonly credentials?: StoredCredentials; readonly problem?: "unreadable" | "invalid" }> {
		const result = this.inner.probe ? await this.inner.probe() : { credentials: await this.inner.load() };
		this.track(result.credentials);
		return result;
	}

	async save(c: StoredCredentials): Promise<void> {
		this.track(c);
		await this.serialised(() => this.inner.save(c));
	}

	clear(): Promise<void> {
		return this.serialised(() => this.inner.clear());
	}

	/** Writes and clears run one after another, in call order: a slow save cannot land after a later clear. */
	private queue: Promise<unknown> = Promise.resolve();
	private serialised<T>(work: () => Promise<T>): Promise<T> {
		const run = this.queue.then(work, work);
		this.queue = run.catch(() => undefined);
		return run;
	}
}

export function createWeatherService(options: WeatherServiceOptions = {}): WeatherService {
	const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
	const now = options.now ?? Date.now;
	const fetchImpl = options.fetchImpl;
	const knownSecrets = new SecretRegistry();
	const root = redactingLogger(options.logger ?? scopedLogger("netatmo"), () => knownSecrets.values());
	const log = prefixed(root, "service");
	const fileStore = new FileCredentialStore({ dataDir: options.dataDir, logger: prefixed(root, "credentials") });
	const store = new TrackingStore(fileStore, knownSecrets);

	const tokens = new TokenManager({ store, fetchImpl, baseUrl, now, logger: prefixed(root, "tokens") });
	const budget = new RequestBudget();
	const client = new NetatmoClient({ tokens, fetchImpl, baseUrl, now, budget, logger: prefixed(root, "client") });
	const history = new HistoryService({
		client,
		getSnapshot: () => poller.getSnapshot(),
		hasCredentials: () => tokens.hasCredentials(),
		now,
		logger: prefixed(root, "history"),
	});
	/** Every place that resets the token manager also drops cached and in-flight history. */
	const resetTokens = (): void => {
		tokens.reset();
		history.invalidate();
	};
	const poller = new Poller({
		fetchSnapshot: () => client.fetchSnapshot(),
		hasCredentials: () => tokens.hasCredentials(),
		warning: () => (tokens.hasUnpersistedRotation ? "unpersisted-rotation" : undefined),
		intervalSeconds: options.pollIntervalSeconds,
		now,
		random: options.random,
		logger: prefixed(root, "poller"),
	});

	let disposed = false;
	let busy = false;
	let login: BrowserLoginHandle | undefined;

	async function setCredentials(input: CredentialInput): Promise<SetCredentialsResult> {
		if (disposed) return { ok: false, error: "The plugin is shutting down." };
		const parsed = parseCredentialInput(input);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		const candidate: StoredCredentials = parsed.value;
		if (busy) return { ok: false, error: "Another sign-in is still in progress." };
		busy = true;
		try {
			store.track(candidate);
			const staging = new MemoryCredentialStore(candidate);
			const stagingTokens = new TokenManager({ store: staging, fetchImpl, baseUrl, now, logger: prefixed(root, "tokens") });
			const stagingClient = new NetatmoClient({ tokens: stagingTokens, fetchImpl, baseUrl, now, logger: prefixed(root, "client") });
			let snapshot: StationSnapshot | undefined;
			let failure: ReturnType<typeof toNetatmoError> | undefined;
			try {
				snapshot = await stagingClient.fetchSnapshot();
			} catch (error) {
				failure = toNetatmoError(error, log);
			}
			const rotated = staging.value;
			if (!staging.wasSaved || !rotated) {
				// the refresh did not happen or was rejected: the credentials are no good, keep what we have
				return { ok: false, error: failure?.message ?? "Sign-in could not be verified." };
			}
			store.track(rotated);
			// Invalidate BEFORE and AFTER the write: a refresh with the OLD credentials that is in
			// flight right now must not be persisted over the new pair (see TokenManager generations).
			resetTokens();
			let writeFailure: string | undefined;
			try {
				await store.save(rotated);
			} catch (error) {
				writeFailure = errnoOf(error);
				log.error(`could not persist credentials after sign-in (${writeFailure})`);
				// The pasted refresh token is used up and the rotated one is the only valid pair: keep it
				// alive in memory (written again on every poll) instead of throwing it away.
				tokens.adoptUnpersisted(rotated);
				history.invalidate();
			}
			if (writeFailure === undefined) resetTokens();
			if (snapshot) poller.adoptSnapshot(snapshot);
			else await poller.credentialsChanged();
			if (writeFailure !== undefined) {
				return {
					ok: false,
					saved: false,
					error: `Signed in, but the credentials could not be saved (${writeFailure}: ${writeFailureCause(writeFailure)}). The plugin keeps working until Stream Deck restarts and tries to save again on every update. Free space or check the permissions of ${fileStore.dir}; if the problem stays, create a new token pair and enter it again.`,
				};
			}
			if (snapshot) return { ok: true, snapshot };
			if (failure?.kind === "auth") {
				// the poller stopped on the same error: do not promise a retry
				return {
					ok: false,
					saved: true,
					error:
						failure.code === "13"
							? "Saved, but Netatmo does not allow reading station data with this token (missing read_station scope?). Create the token again with only read_station."
							: `Saved, but Netatmo rejected the station request: ${failure.message}`,
				};
			}
			return {
				ok: false,
				saved: true,
				error: `Signed in, but loading station data failed: ${failure?.message ?? "unknown error"} Polling will retry.`,
			};
		} finally {
			busy = false;
		}
	}

	const service: WeatherService = {
		getSnapshot: () => poller.getSnapshot(),
		getConnectionState: () => poller.getConnectionState(),
		subscribe: (listener) => poller.subscribe(listener),
		refresh: () => poller.refresh(),
		credentialsChanged: async () => {
			resetTokens();
			await poller.credentialsChanged();
		},

		credentialsLocation: fileStore.filePath,

		async getCredentialSummary(): Promise<CredentialSummary> {
			const { credentials, problem } = await store.probe();
			if (credentials) return { configured: true, clientIdHint: credentials.clientId.slice(-4) };
			// a damaged or unreadable file is not "not set up": the user has to act on it
			return problem ? { configured: false, unreadable: true } : { configured: false };
		},

		setCredentials,

		async clearCredentials(): Promise<void> {
			// reset BEFORE the clear so no new refresh starts with the old pair, and AFTER it so a
			// refresh that started in between (it re-read the store) is discarded too
			resetTokens();
			try {
				await store.clear();
			} catch (error) {
				// the file is still there: nothing was cleared, so polling goes on with it
				const code = errnoOf(error);
				log.error(`could not remove the credentials file (${code})`);
				throw new ClearCredentialsError(code, fileStore.filePath);
			}
			resetTokens();
			await poller.credentialsChanged();
		},

		async startBrowserLogin(input, openUrl, onPhase): Promise<void> {
			if (disposed) {
				onPhase({ phase: "error", message: "The plugin is shutting down." });
				return;
			}
			// the same check as the paste route, BEFORE the browser opens: the authorization code is single use
			const parsed = parseLoginInput(input);
			if (!parsed.ok) {
				onPhase({ phase: "error", message: parsed.error });
				return;
			}
			login?.cancel("Replaced by a newer sign-in attempt.");
			knownSecrets.add([parsed.value.clientSecret]);
			const handle = startBrowserLogin({
				clientId: parsed.value.clientId,
				clientSecret: parsed.value.clientSecret,
				port: options.loopbackPort ?? DEFAULT_LOOPBACK_PORT,
				// reset the token manager before the write, too (see setCredentials)
				store: {
					load: () => store.load(),
					clear: () => store.clear(),
					save: async (c) => {
						resetTokens();
						await store.save(c);
					},
				},
				openUrl,
				onPhase: (phase: BrowserLoginPhase) => onPhase(phase),
				fetchImpl,
				baseUrl,
				now,
				logger: prefixed(root, "login"),
				onSuccess: async () => {
					resetTokens();
					try {
						await poller.credentialsChanged();
					} catch (error) {
						log.error(`restarting the poller after sign-in failed: ${describeUnexpected(error)}`);
					}
				},
				// the grant is valid at Netatmo but the write failed: keep it alive in memory (see setCredentials)
				onSaveFailed: async (credentials) => {
					store.track(credentials);
					tokens.adoptUnpersisted(credentials);
					history.invalidate();
					try {
						await poller.credentialsChanged();
					} catch (error) {
						log.error(`restarting the poller after sign-in failed: ${describeUnexpected(error)}`);
					}
				},
			});
			login = handle;
			await handle.finished;
			if (login === handle) login = undefined;
		},

		getHistory: (request: HistoryRequest): Promise<HistoryResult> => history.getHistory(request),

		setPollInterval: (seconds) => poller.setIntervalSeconds(seconds),

		dispose(): void {
			if (disposed) return;
			disposed = true;
			login?.cancel("The plugin is shutting down.");
			login = undefined;
			history.invalidate();
			poller.dispose();
		},
	};
	return service;
}

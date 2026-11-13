/**
 * Wires credentials, token manager, client and poller into the WeatherService declared in
 * service.ts. SDK-free.
 *
 * `setCredentials` validates through the SAME code path as normal polling (TokenManager +
 * NetatmoClient) but against a staging store, so a wrong pasted token can never clobber
 * working credentials. One subtlety, because refresh tokens rotate: validation consumes the
 * pasted refresh token. Once the refresh succeeded the rotated pair is the ONLY valid one,
 * so it is persisted even if the following getstationsdata request fails (then the result is
 * `ok: false, saved: true` with an explanation, and polling retries by itself). If the refresh itself is
 * rejected or fails, nothing is written.
 */

import { type AdapterLogger, scopedLogger } from "../logging.ts";
import { type BrowserLoginHandle, DEFAULT_LOOPBACK_PORT, startBrowserLogin } from "./browser-login.ts";
import {
	type CredentialStore,
	FileCredentialStore,
	MemoryCredentialStore,
	type StoredCredentials,
	validateCredentials,
} from "./credentials.ts";
import { RequestBudget } from "./budget.ts";
import { NetatmoClient } from "./client.ts";
import { toNetatmoError } from "./errors.ts";
import { HistoryService } from "./history.ts";
import { Poller } from "./poller.ts";
import { redactingLogger } from "./redact.ts";
import type {
	BrowserLoginPhase,
	CredentialInput,
	SetCredentialsResult,
	WeatherService,
	WeatherServiceOptions,
} from "./service.ts";
import { DEFAULT_BASE_URL, TokenManager, UNPERSISTED_ROTATION_MESSAGE } from "./token-manager.ts";
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

/** Remembers every secret that passes through the store so the logger can mask it. */
/** Exported for tests only. */
export class TrackingStore implements CredentialStore {
	private readonly secrets: Set<string>;
	private readonly inner: CredentialStore;

	constructor(inner: CredentialStore, secrets: Set<string>) {
		this.inner = inner;
		this.secrets = secrets;
	}

	track(c: StoredCredentials | undefined): void {
		if (!c) return;
		this.secrets.add(c.clientSecret);
		this.secrets.add(c.refreshToken);
		if (c.accessToken) this.secrets.add(c.accessToken);
	}

	async load(): Promise<StoredCredentials | undefined> {
		const c = await this.inner.load();
		this.track(c);
		return c;
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
	const knownSecrets = new Set<string>();
	const root = redactingLogger(options.logger ?? scopedLogger("netatmo"), () => [...knownSecrets]);
	const store = new TrackingStore(new FileCredentialStore({ dataDir: options.dataDir, logger: prefixed(root, "credentials") }), knownSecrets);

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
		warning: () => (tokens.hasUnpersistedRotation ? UNPERSISTED_ROTATION_MESSAGE : undefined),
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
		const candidate = validateCredentials({
			clientId: input.clientId?.trim(),
			clientSecret: input.clientSecret?.trim(),
			refreshToken: input.refreshToken?.trim(),
		});
		if (!candidate) {
			return { ok: false, error: "Client ID, client secret and refresh token are required (no spaces, at most 512 characters each)." };
		}
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
				failure = toNetatmoError(error);
			}
			const rotated = staging.value;
			if (staging.saveCount === 0 || !rotated) {
				// the refresh did not happen or was rejected: the credentials are no good, keep what we have
				return { ok: false, error: failure?.message ?? "Sign-in could not be verified." };
			}
			store.track(rotated);
			// Invalidate BEFORE and AFTER the write: a refresh with the OLD credentials that is in
			// flight right now must not be persisted over the new pair (see TokenManager generations).
			resetTokens();
			try {
				await store.save(rotated);
			} catch {
				return {
					ok: false,
					saved: false,
					error: "The credentials were accepted but could not be saved to disk. The pasted refresh token is used up: create a new token pair and enter it again.",
				};
			}
			resetTokens();
			if (snapshot) {
				poller.adoptSnapshot(snapshot);
				return { ok: true, snapshot };
			}
			await poller.credentialsChanged();
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

		async getCredentialSummary(): Promise<CredentialSummary> {
			const c = await store.load();
			return c ? { configured: true, clientIdHint: c.clientId.slice(-4) } : { configured: false };
		},

		setCredentials,

		async clearCredentials(): Promise<void> {
			// reset BEFORE the clear so no new refresh starts with the old pair, and AFTER it so a
			// refresh that started in between (it re-read the store) is discarded too
			resetTokens();
			await store.clear();
			resetTokens();
			await poller.credentialsChanged();
		},

		async startBrowserLogin(input, openUrl, onPhase): Promise<void> {
			if (disposed) {
				onPhase({ phase: "error", message: "The plugin is shutting down." });
				return;
			}
			login?.cancel("Replaced by a newer sign-in attempt.");
			knownSecrets.add(input.clientSecret);
			const handle = startBrowserLogin({
				clientId: input.clientId.trim(),
				clientSecret: input.clientSecret.trim(),
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
					} catch {
						root.warn("restarting the poller after sign-in failed");
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

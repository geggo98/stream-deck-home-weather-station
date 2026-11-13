/**
 * Access-token lifecycle with a ROTATING refresh token.
 *
 * Netatmo invalidates the previous refresh token the moment a refresh succeeds ("former
 * values are immediately invalidated and can't be reused", OAuth docs). So:
 *
 *  1. single flight: any number of concurrent callers share ONE refresh request;
 *  2. the new pair is persisted BEFORE the new access token is returned to anyone;
 *  3. a rejected refresh token is remembered (sticky) and never sent again: no retry loop
 *     that would hammer the service with a dead token. It is forgotten only by `reset()`
 *     (credentials changed); the refresh token is compared as a second guard, and a rejection
 *     that arrives after a `reset()` is not recorded at all;
 *  4. refresh happens `refreshMarginMs` (60 s) before expiry.
 *
 * If persisting fails (two attempts) after the service already rotated the token, the new
 * access token IS returned and used, and the rotated pair is kept in MEMORY ONLY (the old
 * one is dead anyway). What happens then, exactly:
 *   - each failed attempt is logged at error level (error code only, never a value);
 *   - `hasUnpersistedRotation` turns true; the poller turns it into `{kind: "ok", warning:
 *     "unpersisted-rotation"}` (the human text is `UNPERSISTED_ROTATION_MESSAGE`) while data keeps flowing;
 *   - the write is retried at the start of every `getAccessToken()` (that is, every poll);
 *     on success the flag and the message disappear;
 *   - if the plugin restarts before a write succeeded, the disk still holds the DEAD old
 *     refresh token: the next refresh is rejected and the user has to sign in again.
 * The alternative (throwing away the only valid token) would break the running session for
 * nothing.
 *
 * Generations: `reset()` (credentials changed or cleared) starts a new generation. A refresh
 * that was in flight at that moment finishes into the void: it neither updates the cache
 * nor writes to the store, so Clear and a new sign-in cannot be undone by an old refresh.
 *
 * Scope of the lock: one process. Two plugin processes on the same data directory are not
 * supported (the second refresh would invalidate the first one's token).
 */

import { type AdapterLogger, scopedLogger } from "../logging.ts";
import type { CredentialStore, StoredCredentials } from "./credentials.ts";
import { NetatmoError } from "./errors.ts";
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, assertSafeBaseUrl } from "./http.ts";
import { requestToken } from "./oauth.ts";

export const DEFAULT_BASE_URL = "https://api.netatmo.com";
export const REFRESH_MARGIN_MS = 60_000;

/** Human text for the connection state's `warning: "unpersisted-rotation"`: shown while a rotated token pair exists only in memory. */
export const UNPERSISTED_ROTATION_MESSAGE =
	"The renewed sign-in could not be saved to disk. Data is current, but after a restart you will have to sign in again.";

/** What the client needs from a token manager. */
export interface TokenProvider {
	getAccessToken(): Promise<string>;
	/** Called after the service rejected `rejectedAccessToken`. Coalesces with a refresh already running. */
	forceRefresh(rejectedAccessToken: string): Promise<string>;
}

export interface TokenManagerOptions {
	readonly store: CredentialStore;
	readonly fetchImpl?: typeof fetch;
	readonly baseUrl?: string;
	readonly now?: () => number;
	readonly logger?: AdapterLogger;
	readonly timeoutMs?: number;
	readonly refreshMarginMs?: number;
}

export class TokenManager implements TokenProvider {
	private readonly store: CredentialStore;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;
	private readonly now: () => number;
	private readonly log: AdapterLogger;
	private readonly timeoutMs: number;
	private readonly marginMs: number;
	private creds: StoredCredentials | undefined;
	private unpersisted = false;
	private inflight: Promise<string> | undefined;
	/** Bumped by reset(); a refresh from an older generation must not touch cache or store. */
	private generation = 0;
	private rejectedRefreshToken: string | undefined;
	private rejectedError: NetatmoError | undefined;
	private refreshCount = 0;

	constructor(options: TokenManagerOptions) {
		this.store = options.store;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		assertSafeBaseUrl(this.baseUrl);
		this.now = options.now ?? Date.now;
		this.log = options.logger ?? scopedLogger("netatmo.tokens");
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.marginMs = options.refreshMarginMs ?? REFRESH_MARGIN_MS;
	}

	/** Number of refresh requests sent; read-only, for tests and diagnostics. */
	get refreshRequests(): number {
		return this.refreshCount;
	}

	/**
	 * Take over a credential pair that is valid at the service but could not be written (the
	 * caller's save failed): it becomes the live pair, flagged as unpersisted, so the write is
	 * retried on every `getAccessToken()` like after a failed refresh. Starts a new generation
	 * first, so nothing from the old credentials survives.
	 */
	adoptUnpersisted(credentials: StoredCredentials): void {
		this.reset();
		this.creds = credentials;
		this.unpersisted = true;
	}

	/** Forget cached credentials and any remembered rejection (call when the store changed). */
	reset(): void {
		this.generation++;
		this.inflight = undefined;
		this.creds = undefined;
		this.unpersisted = false;
		this.rejectedRefreshToken = undefined;
		this.rejectedError = undefined;
	}

	async hasCredentials(): Promise<boolean> {
		return (await this.current()) !== undefined;
	}

	private async current(): Promise<StoredCredentials | undefined> {
		for (;;) {
			if (this.creds) return this.creds;
			const generation = this.generation;
			const loaded = await this.store.load();
			// reset() during the load: what we read may belong to the old credentials; read again
			if (generation !== this.generation) continue;
			this.creds = loaded;
			return loaded;
		}
	}

	private accessTokenUsable(c: StoredCredentials): c is StoredCredentials & { accessToken: string } {
		return c.accessToken !== undefined && c.accessTokenExpiresAt !== undefined && c.accessTokenExpiresAt - this.marginMs > this.now();
	}

	async getAccessToken(): Promise<string> {
		const c = await this.current();
		if (!c) throw new NetatmoError("auth", "Not signed in", { code: "no-credentials" });
		// retry a write that failed earlier; the rotated pair must not live in memory only for long
		if (this.unpersisted) {
			const generation = this.generation;
			const persisted = await this.persist(c, generation);
			if (generation === this.generation) this.unpersisted = !persisted;
		}
		if (this.accessTokenUsable(c)) return c.accessToken;
		return this.refresh();
	}

	async forceRefresh(rejectedAccessToken: string): Promise<string> {
		if (this.inflight) return this.inflight;
		const c = await this.current();
		if (!c) throw new NetatmoError("auth", "Not signed in", { code: "no-credentials" });
		// someone refreshed while the caller's request was in flight: use that token
		if (c.accessToken !== undefined && c.accessToken !== rejectedAccessToken && this.accessTokenUsable(c)) return c.accessToken;
		return this.refresh();
	}

	private refresh(): Promise<string> {
		if (!this.inflight) {
			const run = this.doRefresh();
			this.inflight = run;
			const clear = () => {
				if (this.inflight === run) this.inflight = undefined;
			};
			run.then(clear, clear);
		}
		return this.inflight;
	}

	private async persist(next: StoredCredentials, generation = this.generation): Promise<boolean> {
		for (let attempt = 1; attempt <= 2; attempt++) {
			// credentials were cleared or replaced meanwhile: writing now would undo that
			if (generation !== this.generation) return true;
			try {
				await this.store.save(next);
				return true;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code;
				this.log.error(`could not persist credentials (attempt ${attempt}/2, ${typeof code === "string" ? code : "error"})`);
			}
		}
		return false;
	}

	private async doRefresh(): Promise<string> {
		const generation = this.generation;
		const stored = await this.current();
		if (!stored) throw new NetatmoError("auth", "Not signed in", { code: "no-credentials" });
		if (this.rejectedRefreshToken === stored.refreshToken && this.rejectedError) {
			// sticky: do not send a token the service already rejected
			throw this.rejectedError;
		}
		this.refreshCount++;
		let grant;
		try {
			grant = await requestToken(
				this.fetchImpl,
				this.baseUrl,
				{
					grant_type: "refresh_token",
					refresh_token: stored.refreshToken,
					client_id: stored.clientId,
					client_secret: stored.clientSecret,
				},
				{ timeoutMs: this.timeoutMs, maxBytes: DEFAULT_MAX_RESPONSE_BYTES },
				this.now,
			);
		} catch (error) {
			if (error instanceof NetatmoError && error.kind === "auth") {
				// a rejection of the OLD credentials must not mark the new ones as rejected
				if (generation === this.generation) {
					this.rejectedRefreshToken = stored.refreshToken;
					this.rejectedError = error;
				}
				this.log.warn(`refresh token rejected (${error.status ?? "?"} ${error.code ?? ""}); polling needs a new sign-in`);
			} else {
				this.log.warn(`token refresh failed (${error instanceof NetatmoError ? error.kind : "error"})`);
			}
			throw error;
		}
		if (generation !== this.generation) {
			// Clear or a new sign-in happened while the request was in flight. The grant belongs to
			// the old credentials: do not cache it and do not write it to the store.
			throw new NetatmoError("transient", "The credentials changed during the refresh; the result was discarded.");
		}
		const next: StoredCredentials = {
			clientId: stored.clientId,
			clientSecret: stored.clientSecret,
			refreshToken: grant.refreshToken,
			accessToken: grant.accessToken,
			accessTokenExpiresAt: this.now() + grant.expiresInSeconds * 1000,
		};
		// Memory first: from here on the old refresh token is dead, the new pair is the only truth.
		this.creds = next;
		// PERSIST BEFORE RETURNING the access token (see header comment).
		const persisted = await this.persist(next, generation);
		if (generation === this.generation) this.unpersisted = !persisted;
		this.log.debug("token refreshed");
		return grant.accessToken;
	}

	/** True when the last rotated pair could not be written to the store (it lives in memory only). */
	get hasUnpersistedRotation(): boolean {
		return this.unpersisted;
	}
}

/**
 * EXPERIMENTAL browser sign-in: OAuth2 authorization-code grant with a loopback redirect.
 *
 * UNVERIFIED against the live service (no real app was available when this was written):
 *  - whether Netatmo accepts `http://localhost:<port>/callback` as redirect URI (the docs only
 *    say it "must exactly match" the registered one; the user has to register it in the app);
 *  - whether PKCE would be accepted: the docs do not mention it, so it is NOT used;
 *  - what `scope` the token response echoes.
 * The verified bootstrap path is pasting the token pair from the developer portal
 * (`WeatherService.setCredentials`). This flow exists so the loopback variant can be tried.
 *
 * Security properties (each has a test):
 *  - the listener binds to 127.0.0.1 only, on one configured port;
 *  - only `GET /callback` with the exact random `state` is accepted; anything else gets a
 *    fixed 400/404 page and does NOT end the flow (a stray request must not be able to
 *    cancel a login);
 *  - the `Host` header must be localhost or 127.0.0.1 with our port (DNS-rebinding guard);
 *  - the reply is a fixed HTML page: nothing from the request is reflected;
 *  - the listener closes after the first valid callback or after 3 minutes;
 *  - the authorization code and tokens are never logged;
 *  - `cancel()` before the credentials are being written discards a running code exchange:
 *    nothing is saved and `onSuccess` does not run. After that point cancel is a no-op and
 *    the flow ends as "done" (the PI never says "error" for credentials that were saved).
 *
 * The redirect URI uses `localhost` while we listen on 127.0.0.1 only: a browser that
 * resolves `localhost` to ::1 first falls back to IPv4 (all mainstream browsers do).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { type AddressInfo } from "node:net";
import { type AdapterLogger, scopedLogger } from "../logging.ts";
import type { CredentialStore } from "./credentials.ts";
import { NetatmoError } from "./errors.ts";
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, assertSafeBaseUrl, joinUrl } from "./http.ts";
import { SCOPE, requestToken } from "./oauth.ts";
import type { BrowserLoginPhase } from "./service.ts";
import { DEFAULT_BASE_URL } from "./token-manager.ts";

export const DEFAULT_LOOPBACK_PORT = 53682;
export const BROWSER_LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_CODE_LENGTH = 512;

export interface BrowserLoginOptions {
	readonly clientId: string;
	readonly clientSecret: string;
	/** 0 = pick a free port (tests). */
	readonly port?: number;
	readonly store: CredentialStore;
	readonly openUrl: (url: string) => Promise<void>;
	readonly onPhase: (phase: BrowserLoginPhase) => void;
	readonly fetchImpl?: typeof fetch;
	readonly baseUrl?: string;
	readonly now?: () => number;
	readonly logger?: AdapterLogger;
	/** Timeout of each HTTP request to the token endpoint. */
	readonly timeoutMs?: number;
	/** How long to wait for the browser callback; default 3 minutes. Tests shorten it. */
	readonly loginTimeoutMs?: number;
	readonly randomState?: () => string;
	/** Called after the credentials were persisted and before the "done" phase. */
	readonly onSuccess?: () => Promise<void> | void;
}

/** Handle for cancelling a running flow (dispose, or a second flow replacing the first). */
export interface BrowserLoginHandle {
	cancel(message?: string): void;
	/** Resolves when the flow has ended (done, error, timeout or cancel). Never rejects. */
	readonly finished: Promise<void>;
}

const PAGE_OK = "<!doctype html><meta charset=\"utf-8\"><title>Signed in</title><p>Sign-in finished. You can close this tab and return to Stream Deck.</p>";
const PAGE_DENIED = "<!doctype html><meta charset=\"utf-8\"><title>Sign-in failed</title><p>Sign-in was not completed. You can close this tab.</p>";
const PAGE_BAD = "<!doctype html><meta charset=\"utf-8\"><title>Bad request</title><p>Bad request.</p>";

function reply(res: http.ServerResponse, status: number, html: string): void {
	res.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
		"Content-Security-Policy": "default-src 'none'",
		"X-Content-Type-Options": "nosniff",
		Connection: "close",
	});
	res.end(html);
}

function sameSecret(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function startBrowserLogin(options: BrowserLoginOptions): BrowserLoginHandle {
	const log = options.logger ?? scopedLogger("netatmo.login");
	const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
	assertSafeBaseUrl(baseUrl);
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const state = (options.randomState ?? (() => randomBytes(24).toString("base64url")))();
	const server = http.createServer();
	let ended = false;
	/** True from the moment the credentials are being written: a cancel can no longer undo that. */
	let committing = false;
	const exchange = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	let redirectUri = "";
	let resolveFinished: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		resolveFinished = resolve;
	});

	const shutdown = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (server.listening) {
			server.close();
			server.closeAllConnections();
		}
	};
	const end = (phase: BrowserLoginPhase): void => {
		if (ended) return;
		ended = true;
		if (!committing) exchange.abort(); // stop a running code exchange; its result is not wanted
		shutdown();
		try {
			options.onPhase(phase);
		} catch {
			log.warn("onPhase threw; ignored");
		}
		resolveFinished();
	};
	const fail = (message: string): void => end({ phase: "error", message });

	async function finish(code: string): Promise<void> {
		try {
			const grant = await requestToken(
				fetchImpl,
				baseUrl,
				{
					grant_type: "authorization_code",
					client_id: options.clientId,
					client_secret: options.clientSecret,
					code,
					redirect_uri: redirectUri,
					scope: SCOPE,
				},
				{ timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: DEFAULT_MAX_RESPONSE_BYTES, signal: exchange.signal },
				now,
			);
			// Cancelled (superseded, disposed, timed out) while the exchange was running: the user
			// was told the flow ended, so nothing may be saved now. The check and the start of the
			// write are one synchronous step.
			if (ended) {
				log.info("sign-in ended during the code exchange; the result was discarded");
				return;
			}
			committing = true;
			// persist before anything else: this refresh token is the only valid one
			await options.store.save({
				clientId: options.clientId,
				clientSecret: options.clientSecret,
				refreshToken: grant.refreshToken,
				accessToken: grant.accessToken,
				accessTokenExpiresAt: now() + grant.expiresInSeconds * 1000,
			});
			await options.onSuccess?.();
			end({ phase: "done" });
		} catch (error) {
			const message = error instanceof NetatmoError ? error.message : "Sign-in failed";
			log.warn(`code exchange failed: ${message}`);
			fail(message);
		}
	}

	server.on("request", (req, res) => {
		if (ended) {
			reply(res, 410, PAGE_BAD);
			return;
		}
		const host = (req.headers.host ?? "").toLowerCase();
		const port = (server.address() as AddressInfo | null)?.port;
		if (req.method !== "GET" || (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`)) {
			reply(res, 400, PAGE_BAD);
			return;
		}
		let url: URL;
		try {
			url = new URL(req.url ?? "/", "http://127.0.0.1");
		} catch {
			reply(res, 400, PAGE_BAD);
			return;
		}
		if (url.pathname !== "/callback") {
			reply(res, 404, PAGE_BAD);
			return;
		}
		const gotState = url.searchParams.get("state") ?? "";
		if (!sameSecret(gotState, state)) {
			reply(res, 400, PAGE_BAD); // wrong state: ignore, keep waiting
			return;
		}
		// From here on the request is the genuine callback: whatever it says, the flow ends.
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		if (error !== null || code === null || code.length === 0 || code.length > MAX_CODE_LENGTH) {
			reply(res, 400, PAGE_DENIED);
			// the `error` value is NOT reflected: only a fixed message
			fail(error !== null ? "Authorization was denied or cancelled." : "The callback carried no authorization code.");
			return;
		}
		reply(res, 200, PAGE_OK);
		// stop accepting immediately; the exchange continues without the listener
		if (timer) clearTimeout(timer);
		timer = undefined;
		server.close();
		server.closeAllConnections();
		void finish(code);
	});

	server.on("error", (error: NodeJS.ErrnoException) => {
		fail(error.code === "EADDRINUSE" ? "The sign-in port is already in use." : "Could not start the local sign-in listener.");
	});

	server.listen({ port: options.port ?? DEFAULT_LOOPBACK_PORT, host: "127.0.0.1" }, () => {
		const port = (server.address() as AddressInfo).port;
		redirectUri = `http://localhost:${port}/callback`;
		timer = setTimeout(() => fail("Sign-in timed out after 3 minutes."), options.loginTimeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS);
		timer.unref?.();
		const authorize = `${joinUrl(baseUrl, "/oauth2/authorize")}?${new URLSearchParams({
			client_id: options.clientId,
			redirect_uri: redirectUri,
			scope: SCOPE,
			state,
		}).toString()}`;
		try {
			options.onPhase({ phase: "waiting", redirectUri });
		} catch {
			log.warn("onPhase threw; ignored");
		}
		options.openUrl(authorize).catch(() => fail("Could not open the browser."));
	});

	return {
		cancel(message = "Sign-in was cancelled.") {
			// too late once the credentials are being written: the flow ends as "done"
			if (committing) return;
			fail(message);
		},
		finished,
	};
}

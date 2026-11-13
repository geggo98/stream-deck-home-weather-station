/**
 * Credential persistence: a 0600 JSON file in the per-user data directory.
 *
 * Design constraints (see docs/ARCHITECTURE.md, "Authentication and secrets"):
 *  - The refresh token ROTATES on every refresh, so a torn or lost write means a full
 *    re-authorisation. Writes are therefore atomic: temp file in the same directory,
 *    chmod 0600 before the rename, rename over the target.
 *  - A corrupt, partial, oversized or foreign file yields no credentials, never a crash. The
 *    content is NOT logged (it may contain a secret); only the reason class is. `probe()`
 *    reports that class, so the PI can tell "damaged or unreadable" from "not set up".
 *  - On Windows chmod is a no-op; the file then relies on the per-user %APPDATA% ACL.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type AdapterLogger, scopedLogger } from "../logging.ts";
import { defaultDataDir } from "./paths.ts";
import type { CredentialInput, LoginInput } from "./service.ts";

export const CREDENTIALS_FILE_NAME = "credentials.json";
/** A real file is ~400 bytes; anything above this is not ours. */
export const MAX_CREDENTIALS_FILE_BYTES = 16 * 1024;
/** Real values are 24..64 characters; this bounds what we accept from the file or the PI. */
export const MAX_FIELD_LENGTH = 512;

interface StoredCredentialsBase {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly refreshToken: string;
}

/**
 * The access token and its expiry belong together: both present or both absent (the file
 * keeps them as two flat fields, so older files stay readable).
 */
export type StoredCredentials = StoredCredentialsBase &
	(
		| { readonly accessToken?: undefined; readonly accessTokenExpiresAt?: undefined }
		| {
				readonly accessToken: string;
				/** Epoch milliseconds. */
				readonly accessTokenExpiresAt: number;
		  }
	);

/** Why a credentials file did not yield credentials, when it exists at all. */
export type CredentialProblem = "unreadable" | "invalid";

export interface CredentialStore {
	/** undefined = not configured (missing, corrupt or invalid file). */
	load(): Promise<StoredCredentials | undefined>;
	/**
	 * Like `load`, but says WHY nothing came back: no problem = simply not set up; "unreadable" =
	 * the file exists but cannot be read (permissions); "invalid" = too large, not JSON, or foreign content.
	 */
	probe?(): Promise<{ readonly credentials?: StoredCredentials; readonly problem?: CredentialProblem }>;
	save(credentials: StoredCredentials): Promise<void>;
	clear(): Promise<void>;
}

export function isCleanToken(value: unknown): value is string {
	// no whitespace or control characters: these values end up in headers and form bodies
	return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(value);
}

/** Strict validation shared by load, save and the PI path. Returns a normalised copy. */
export function validateCredentials(raw: unknown): StoredCredentials | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (!isCleanToken(r.clientId) || !isCleanToken(r.clientSecret) || !isCleanToken(r.refreshToken)) return undefined;
	const base: StoredCredentials = { clientId: r.clientId, clientSecret: r.clientSecret, refreshToken: r.refreshToken };
	if (r.accessToken === undefined) return base;
	if (!isCleanToken(r.accessToken)) return undefined;
	const exp = r.accessTokenExpiresAt;
	// a missing or nonsensical expiry only costs one extra refresh: drop the access token instead of failing
	if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return base;
	return { ...base, accessToken: r.accessToken, accessTokenExpiresAt: exp };
}

export type ParsedInput<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const FIELD_LABELS = { clientId: "client ID", clientSecret: "client secret", refreshToken: "refresh token" } as const;

function parseField(raw: Record<string, unknown>, key: keyof typeof FIELD_LABELS): ParsedInput<string> {
	const label = FIELD_LABELS[key];
	const value = raw[key];
	// leading and trailing whitespace comes from copy and paste; inside, it is a mistake
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (trimmed.length === 0) return { ok: false, error: `The ${label} is required.` };
	if (trimmed.length > MAX_FIELD_LENGTH) return { ok: false, error: `The ${label} is too long (at most ${MAX_FIELD_LENGTH} characters).` };
	if (!isCleanToken(trimmed)) return { ok: false, error: `The ${label} contains spaces or control characters. Copy only the value itself.` };
	return { ok: true, value: trimmed };
}

/**
 * The ONE validation of what the Property Inspector sends: client ID, client secret and
 * refresh token, each trimmed, non-empty, at most 512 characters, without inner whitespace
 * or control characters. On failure `error` is complete user-facing text naming the first
 * offending field ("too long" is told apart from "required"). Used by the router for the
 * paste route and again by the service, so no path can skip it.
 */
export function parseCredentialInput(raw: unknown): ParsedInput<CredentialInput> {
	const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const clientId = parseField(r, "clientId");
	if (!clientId.ok) return clientId;
	const clientSecret = parseField(r, "clientSecret");
	if (!clientSecret.ok) return clientSecret;
	const refreshToken = parseField(r, "refreshToken");
	if (!refreshToken.ok) return refreshToken;
	return { ok: true, value: { clientId: clientId.value, clientSecret: clientSecret.value, refreshToken: refreshToken.value } };
}

/**
 * Same rules for the browser sign-in, which has no refresh token yet: client ID and client
 * secret only. Checked BEFORE the browser opens, because the authorization code is single use.
 */
export function parseLoginInput(raw: unknown): ParsedInput<LoginInput> {
	const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const clientId = parseField(r, "clientId");
	if (!clientId.ok) return clientId;
	const clientSecret = parseField(r, "clientSecret");
	if (!clientSecret.ok) return clientSecret;
	return { ok: true, value: { clientId: clientId.value, clientSecret: clientSecret.value } };
}

export interface FileCredentialStoreOptions {
	readonly dataDir?: string;
	readonly logger?: AdapterLogger;
	/** Test seam: lets a test make the rename fail to prove the old file survives. */
	readonly renameFile?: (from: string, to: string) => Promise<void>;
}

export class FileCredentialStore implements CredentialStore {
	readonly dir: string;
	readonly filePath: string;
	private readonly log: AdapterLogger;
	private readonly renameFile: (from: string, to: string) => Promise<void>;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: FileCredentialStoreOptions = {}) {
		this.dir = options.dataDir ?? defaultDataDir();
		this.filePath = path.join(this.dir, CREDENTIALS_FILE_NAME);
		this.log = options.logger ?? scopedLogger("netatmo.credentials");
		this.renameFile = options.renameFile ?? ((from, to) => fs.rename(from, to));
	}

	async load(): Promise<StoredCredentials | undefined> {
		return (await this.probe()).credentials;
	}

	async probe(): Promise<{ readonly credentials?: StoredCredentials; readonly problem?: CredentialProblem }> {
		let text: string;
		try {
			const stat = await fs.stat(this.filePath);
			if (!stat.isFile() || stat.size > MAX_CREDENTIALS_FILE_BYTES) {
				this.log.warn(`credentials file ignored: not a regular file or larger than ${MAX_CREDENTIALS_FILE_BYTES} bytes`);
				return { problem: "invalid" };
			}
			text = await fs.readFile(this.filePath, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return {};
			this.log.warn(`credentials file unreadable (${typeof code === "string" ? code : "error"})`);
			return { problem: "unreadable" };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.log.warn("credentials file ignored: not valid JSON (treated as not configured)");
			return { problem: "invalid" };
		}
		const valid = typeof parsed === "object" && parsed !== null && (parsed as { version?: unknown }).version === 1 ? validateCredentials(parsed) : undefined;
		if (!valid) {
			this.log.warn("credentials file ignored: unexpected content (treated as not configured)");
			return { problem: "invalid" };
		}
		return { credentials: valid };
	}

	save(credentials: StoredCredentials): Promise<void> {
		const valid = validateCredentials(credentials);
		if (!valid) return Promise.reject(new Error("refusing to store invalid credentials"));
		// Serialise in-process saves so two writers never interleave their temp files.
		const run = this.queue.then(() => this.write(valid));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async write(credentials: StoredCredentials): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
		const tmp = path.join(this.dir, `${CREDENTIALS_FILE_NAME}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`);
		const body = `${JSON.stringify({ version: 1, ...credentials }, null, "\t")}\n`;
		try {
			// "wx": never write through a pre-existing file or symlink at the temp name
			const handle = await fs.open(tmp, "wx", 0o600);
			try {
				await handle.writeFile(body, "utf8");
				// chmod explicitly: the mode argument above is filtered by the umask and ignored on some filesystems
				await handle.chmod(0o600);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.renameFile(tmp, this.filePath);
		} catch (error) {
			await fs.rm(tmp, { force: true }).catch(() => undefined);
			throw error;
		}
		await this.syncDirectory();
	}

	/** Best effort: makes the rename durable on POSIX; not possible on Windows. */
	private async syncDirectory(): Promise<void> {
		try {
			const dir = await fs.open(this.dir, "r");
			try {
				await dir.sync();
			} finally {
				await dir.close();
			}
		} catch {
			// unsupported on this platform or filesystem; the rename itself already happened
		}
	}

	/** Rejects when the file exists but cannot be removed (the caller must not claim the credentials are gone). */
	async clear(): Promise<void> {
		const run = this.queue.then(() => fs.rm(this.filePath, { force: true }));
		this.queue = run.catch(() => undefined);
		await run;
	}
}

/** In-memory store: staging area for validating new credentials, and tests. */
export class MemoryCredentialStore implements CredentialStore {
	private current: StoredCredentials | undefined;
	private saves = 0;

	constructor(initial?: StoredCredentials) {
		this.current = initial;
	}

	get value(): StoredCredentials | undefined {
		return this.current;
	}

	/** True once `save` was called at least once (the staging store uses this to learn that a refresh happened). */
	get wasSaved(): boolean {
		return this.saves > 0;
	}

	get saveCount(): number {
		return this.saves;
	}

	async load(): Promise<StoredCredentials | undefined> {
		return this.current;
	}

	async save(credentials: StoredCredentials): Promise<void> {
		this.current = credentials;
		this.saves++;
	}

	async clear(): Promise<void> {
		this.current = undefined;
	}
}

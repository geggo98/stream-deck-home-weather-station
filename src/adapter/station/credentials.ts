/**
 * Credential persistence: a 0600 JSON file in the per-user data directory.
 *
 * Design constraints (see docs/ARCHITECTURE.md, "Authentication and secrets"):
 *  - The refresh token ROTATES on every refresh, so a torn or lost write means a full
 *    re-authorisation. Writes are therefore atomic: temp file in the same directory,
 *    chmod 0600 before the rename, rename over the target.
 *  - A corrupt, partial, oversized or foreign file is "not configured", never a crash. The
 *    content is NOT logged (it may contain a secret); only the reason class is.
 *  - On Windows chmod is a no-op; the file then relies on the per-user %APPDATA% ACL.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type AdapterLogger, scopedLogger } from "../logging.ts";
import { defaultDataDir } from "./paths.ts";

export const CREDENTIALS_FILE_NAME = "credentials.json";
/** A real file is ~400 bytes; anything above this is not ours. */
export const MAX_CREDENTIALS_FILE_BYTES = 16 * 1024;
/** Real values are 24..64 characters; this bounds what we accept from the file or the PI. */
export const MAX_FIELD_LENGTH = 512;

export interface StoredCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly refreshToken: string;
	readonly accessToken?: string;
	/** Epoch milliseconds. */
	readonly accessTokenExpiresAt?: number;
}

export interface CredentialStore {
	/** undefined = not configured (missing, corrupt or invalid file). */
	load(): Promise<StoredCredentials | undefined>;
	save(credentials: StoredCredentials): Promise<void>;
	clear(): Promise<void>;
}

function isCleanToken(value: unknown): value is string {
	// no whitespace or control characters: these values end up in headers and form bodies
	return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(value);
}

/** Strict validation shared by load, save and the PI path. Returns a normalised copy. */
export function validateCredentials(raw: unknown): StoredCredentials | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (!isCleanToken(r.clientId) || !isCleanToken(r.clientSecret) || !isCleanToken(r.refreshToken)) return undefined;
	const base = { clientId: r.clientId, clientSecret: r.clientSecret, refreshToken: r.refreshToken };
	if (r.accessToken === undefined) return base;
	if (!isCleanToken(r.accessToken)) return undefined;
	const exp = r.accessTokenExpiresAt;
	// a missing or nonsensical expiry only costs one extra refresh: drop the access token instead of failing
	if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return base;
	return { ...base, accessToken: r.accessToken, accessTokenExpiresAt: exp };
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
		let text: string;
		try {
			const stat = await fs.stat(this.filePath);
			if (!stat.isFile() || stat.size > MAX_CREDENTIALS_FILE_BYTES) {
				this.log.warn(`credentials file ignored: not a regular file or larger than ${MAX_CREDENTIALS_FILE_BYTES} bytes`);
				return undefined;
			}
			text = await fs.readFile(this.filePath, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") this.log.warn(`credentials file unreadable (${typeof code === "string" ? code : "error"})`);
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.log.warn("credentials file ignored: not valid JSON (treated as not configured)");
			return undefined;
		}
		const valid = typeof parsed === "object" && parsed !== null && (parsed as { version?: unknown }).version === 1 ? validateCredentials(parsed) : undefined;
		if (!valid) this.log.warn("credentials file ignored: unexpected content (treated as not configured)");
		return valid;
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

	async clear(): Promise<void> {
		const run = this.queue.then(() => fs.rm(this.filePath, { force: true }));
		this.queue = run.catch(() => undefined);
		await run;
	}
}

/** In-memory store: staging area for validating new credentials, and tests. */
export class MemoryCredentialStore implements CredentialStore {
	private current: StoredCredentials | undefined;
	saveCount = 0;

	constructor(initial?: StoredCredentials) {
		this.current = initial;
	}

	get value(): StoredCredentials | undefined {
		return this.current;
	}

	async load(): Promise<StoredCredentials | undefined> {
		return this.current;
	}

	async save(credentials: StoredCredentials): Promise<void> {
		this.current = credentials;
		this.saveCount++;
	}

	async clear(): Promise<void> {
		this.current = undefined;
	}
}

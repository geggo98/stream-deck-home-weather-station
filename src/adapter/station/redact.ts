/**
 * Secret redaction for everything that is logged. (Nothing secret is "shown": error texts for
 * the Property Inspector are written by the adapter and never copy request or response data.)
 *
 * Two layers: (1) exact replacement of secrets we KNOW (client secret, tokens), including
 * their URL-encoded forms; (2) pattern redaction for secrets we do not know yet (a token
 * echoed by a server, a bearer header, `refresh_token=` in a form body). The token format
 * `<24 hex>|<32 hex>` is from the OAuth page of the Netatmo developer docs.
 */

import type { AdapterLogger } from "../logging.ts";
import { truncateForLog } from "../logging.ts";

const MASK = "***";

/** Secrets shorter than this are not replaced verbatim: they would shred ordinary text. */
const MIN_SECRET_LENGTH = 6;

// Keys whose value is a secret in any of the spellings below.
const SECRET_KEY = "(?:access_token|refresh_token|client_secret|assertion)";

// matches:  Authorization: Bearer 5f1a...|9c0d...   ->  Bearer ***
// matches:  {"access_token":"abc","refresh_token":"def"}  ->  both values replaced
// matches:  {'client_secret': 'xyz'}  (Python/JS object dump)  ->  value replaced
// matches:  {\"refresh_token\":\"abc\"}  (JSON inside a JSON string)  ->  value replaced
// matches:  client_secret: xyz   and   refresh_token = abc   ->  value replaced
// matches:  grant_type=refresh_token&refresh_token=abc&client_secret=xyz   ->  values replaced
// matches:  body=refresh_token%3Dabc%26client_secret%3Dxyz   (form body, percent-encoded again)  ->  values replaced
// matches:  /callback?code=abc&state=def   ->  code replaced (only in query/form context)
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/(Authorization\s*:\s*)[^\r\n]*/gi, `$1${MASK}`],
	[/\b(Bearer)\s+[A-Za-z0-9._~+/=|-]{6,}/gi, `$1 ${MASK}`],
	[
		new RegExp(
			// key, optional (escaped) quotes around it, separator (: = or their %-encoded forms), then the value:
			// a quoted string (closed by the same, possibly backslash-escaped, quote) or a bare run
			String.raw`(?:(?<![A-Za-z0-9])|(?<=%26|%2[Cc]))(\\*["']?` +
				SECRET_KEY +
				String.raw`\\*["']?\s*(?::|=|%3[AaDd])\s*)(?:(\\*["'])(?:(?!\2)[^\\]|(?!\2)\\.)*\2|(?:(?!%26|%2[Cc])[^\s,&;"'}\]])+)`,
			"gi",
		),
		`$1${MASK}`,
	],
	[/((?:^|[?&\s"'])(?:code|state)=)[^&\s"'#]*/gi, `$1${MASK}`],
	[/\b[0-9a-f]{24}(?:\||%7C)[0-9a-f]{32}\b/gi, MASK],
];

/** `%2F` -> `%2f`: some encoders write lower-case hex. */
const lowerHex = (text: string): string => text.replace(/%(?:25)*[0-9A-F]{2}/g, (m) => m.toLowerCase());

/**
 * Every spelling a known secret can take on its way into a log line: raw, percent-encoded
 * (encodeURIComponent, form encoding with `+` for a space, lower-case hex, encoded twice),
 * JSON-escaped (also with `\/`, also escaped twice) and base64 / base64url. Not covered: a
 * secret that was cut in the middle (the pattern layer below is best effort for those).
 */
function variants(secret: string): readonly string[] {
	const cached = VARIANT_CACHE.get(secret);
	if (cached) return cached;
	const computed = computeVariants(secret);
	// bounded: a long session rotates tokens every few hours, and every line asks for every secret
	if (VARIANT_CACHE.size >= VARIANT_CACHE_LIMIT) VARIANT_CACHE.delete(VARIANT_CACHE.keys().next().value as string);
	VARIANT_CACHE.set(secret, computed);
	return computed;
}

const VARIANT_CACHE = new Map<string, readonly string[]>();
const VARIANT_CACHE_LIMIT = 32;

/** Exported for tests only: how many secrets the variant cache currently holds. */
export function variantCacheSize(): number {
	return VARIANT_CACHE.size;
}

function computeVariants(secret: string): string[] {
	const json = JSON.stringify(secret).slice(1, -1);
	const encoded = encodeURIComponent(secret);
	const form = new URLSearchParams({ x: secret }).toString().slice(2);
	const base64 = Buffer.from(secret, "utf8").toString("base64");
	const out = new Set<string>([
		secret,
		encoded,
		form,
		encodeURIComponent(encoded),
		lowerHex(encoded),
		lowerHex(form),
		lowerHex(encodeURIComponent(encoded)),
		json,
		json.replaceAll("/", "\\/"),
		JSON.stringify(json).slice(1, -1),
		base64,
		base64.replace(/=+$/, ""),
		Buffer.from(secret, "utf8").toString("base64url"),
	]);
	try {
		out.add(decodeURIComponent(secret));
	} catch {
		// not percent-encoded; the raw form above is enough
	}
	// longest first: an encoded form must be replaced before a shorter form inside it
	return [...out].filter((v) => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

/**
 * The secrets the logger masks, kept by GENERATION: one generation is the set of values that
 * belong to one credential state (client secret, refresh token, access token). Only the
 * current and the previous generation are retained: a refresh rotates two tokens every few
 * hours, so an unbounded set would grow, and every log line pays for every secret in it.
 * The previous generation stays because a late echo of the token that was just replaced
 * (an in-flight request, a server error body) must still be masked.
 */
export class SecretRegistry {
	static readonly GENERATIONS = 2;
	private generations: Array<readonly string[]> = [];

	/** Start a new generation unless these exact values are already retained. Empty values are ignored. */
	add(secrets: readonly (string | undefined)[]): void {
		const clean = [...new Set(secrets.filter((s): s is string => typeof s === "string" && s.length > 0))];
		if (clean.length === 0) return;
		const key = clean.join("\u0000");
		if (this.generations.some((g) => g.join("\u0000") === key)) return;
		this.generations.push(clean);
		while (this.generations.length > SecretRegistry.GENERATIONS) this.generations.shift();
	}

	/** Every retained value, newest generation first. */
	values(): string[] {
		return [...new Set([...this.generations].reverse().flat())];
	}
}

/** Replace known secrets and anything that looks like a credential. */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
	let out = text;
	for (const secret of knownSecrets) {
		if (!secret) continue;
		for (const v of variants(secret)) out = out.split(v).join(MASK);
	}
	for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

/** Drop the query string and fragment of a URL: they carry codes and tokens. */
export function stripQuery(url: string): string {
	const cut = url.search(/[?#]/);
	return cut < 0 ? url : url.slice(0, cut);
}

/**
 * Wrap a logger so every line is redacted and control-character-escaped. This is the
 * defence in depth; the modules also avoid putting secrets into messages in the first place.
 *
 * @param getSecrets - Called per line, so secrets that appear later (a rotated token) are covered.
 */
export function redactingLogger(base: AdapterLogger, getSecrets: () => readonly string[]): AdapterLogger {
	const wrap = (write: (message: string) => void) => (message: string) =>
		write(truncateForLog(redactSecrets(message, getSecrets()), 400));
	return {
		debug: wrap((m) => base.debug(m)),
		info: wrap((m) => base.info(m)),
		warn: wrap((m) => base.warn(m)),
		error: wrap((m) => base.error(m)),
	};
}

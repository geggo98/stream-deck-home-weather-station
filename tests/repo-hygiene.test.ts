/**
 * Repository hygiene: scans every tracked or untracked-but-not-ignored text file for
 * IDENTIFIER FORMATS (MAC addresses, e-mail addresses, IPv4 addresses, UUIDs, long
 * token-like strings, ticket-like ids, repository slugs, coordinate pairs), not for
 * keywords. An account id or a MAC address stands alone in the code with no telling word
 * next to it, so a keyword search never finds it.
 *
 * A filter that cannot match reports the same as a clean tree, so this file first
 * validates the scanner: a built-in sample containing one of each format must be detected,
 * a sample of allowed look-alikes must not, and the real scan must have looked at a
 * plausible number of files and lines. The samples are assembled from parts at run time on
 * purpose: this file is itself scanned, and a literal sample would be a finding.
 *
 * Allowlist (every entry has a reason; widen it only with a written one):
 *  - MAC: only the documentation range 00:00:5e:00:53:xx (RFC 7042).
 *  - e-mail: only the maintainer address from package.json "author", any
 *    *@users.noreply.github.com / noreply@* address, the git transport user at GitHub, and
 *    retina image names (name@2x.png).
 *  - IPv4: loopback 127/8, 0.0.0.0, and the RFC 5737 ranges 192.0.2/24, 198.51.100/24,
 *    203.0.113/24. A line that mentions "version" is exempt (4-part manifest versions
 *    look like addresses).
 *  - UUID: only the nil UUID. The plugin and action ids are reverse-DNS, not UUID-shaped.
 *  - token-like strings (>= 32 chars): 40-hex commit pins on `uses:` lines in workflows, and
 *    sha256 values in VENDORED.md. Lockfiles and the vendored bundle are not scanned at all
 *    (generated, full of integrity hashes, no human-authored content).
 *  - ticket-like ids: prefixes that are standards, not trackers (see NOT_A_TICKET_PREFIX).
 *  - repository slugs: the owner's own repository plus the public upstream projects listed in
 *    UPSTREAM_SLUGS, which are linked for attribution only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Finding {
	readonly kind: string;
	readonly file: string;
	readonly line: number;
	/** Masked: the log of a failing run must not spread the identifier it found. */
	readonly shown: string;
}

interface Detector {
	readonly kind: string;
	readonly re: RegExp;
	/** true = allowed, do not report. */
	readonly allowed?: (match: string, line: string, file: string) => boolean;
}

const OWN_SLUG = "geggo98/stream-deck-home-weather-station";
const UPSTREAM_SLUGS = new Set([
	"googleapis/release-please", // release tooling, referenced in docs and config schema
	"rollup/plugins", // upstream issue tracker referenced next to a dependabot rule
	"lucide-icons/lucide", // icon set source (NOTICE)
	"geekyeggo/sdpi-components", // vendored Property Inspector library (NOTICE, VENDORED.md)
	"lit/lit", // library bundled in sdpi-components
	"elgatosf/streamdeck", // Stream Deck SDK for Node.js (NOTICE)
]);

// Standards and formats that look like a ticket id ("UTF-8") but are not one.
const NOT_A_TICKET_PREFIX = new Set([
	"UTF", "SHA", "ISO", "AES", "RFC", "TLS", "ECMA", "CVE", "PEP", "MD", "GPT", "HTTP",
	"IEC", "ANSI", "RGB", "CRC", "SSL", "USB", "UTC", "WCAG", "CSS", "EPSG", "GHSA", "OSV",
]);

function maintainerEmail(): string | undefined {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { author?: string };
	return /<(?<mail>[^>]+)>/.exec(pkg.author ?? "")?.groups?.mail?.toLowerCase();
}

function ipv4Allowed(ip: string): boolean {
	const o = ip.split(".").map(Number);
	if (o.some((n) => n > 255)) return true; // not an address at all (version-like, 4 numbers)
	const [a, b, c] = o;
	return (
		a === 127 ||
		ip === "0.0.0.0" ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113)
	);
}

function detectors(): readonly Detector[] {
	const maintainer = maintainerEmail();
	return [
		{
			kind: "mac-address",
			re: /(?<![0-9A-Fa-f:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])/g,
			allowed: (m) => m.toLowerCase().replaceAll("-", ":").startsWith("00:00:5e:00:53:"),
		},
		{
			kind: "email-address",
			re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
			allowed: (m) => {
				const l = m.toLowerCase();
				return (
					l === maintainer ||
					l.endsWith("@users.noreply.github.com") ||
					l.startsWith("noreply@") ||
					l === "git@github.com" ||
					/@\d+x\.[a-z]+$/.test(l) // retina image names such as icon@2x.png, not addresses
				);
			},
		},
		{
			kind: "ipv4-address",
			re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
			allowed: (m, line) => ipv4Allowed(m) || /version/i.test(line),
		},
		{
			kind: "uuid",
			re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
			allowed: (m) => m === "00000000-0000-0000-0000-000000000000",
		},
		{
			kind: "long-hex",
			re: /(?<![0-9A-Za-z+/=_-])[0-9a-fA-F]{32,}(?![0-9A-Za-z+/=_-])/g,
			allowed: (m, line, file) =>
				(m.length === 40 && (/\buses:/.test(line) || new RegExp(`[\\w.-]+/[\\w.-]+@${m}`).test(line))) || // pinned action: `uses:` line or "owner/repo@<sha>" (TRANSITIVE_PINS)
				(file.endsWith("VENDORED.md") && m.length === 64), // sha256 values sit in table rows, away from the header
		},
		{
			kind: "long-base64ish",
			// at least one digit, one lower-case and one upper-case letter: ordinary slugs and
			// identifiers rarely have all three in 32+ characters without a dot or space.
			re: /(?<![0-9A-Za-z+/=_-])(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}(?![0-9A-Za-z+/=_-])/g,
			allowed: (_m, line, file) => file.endsWith("VENDORED.md") && /sha-?256|integrity/i.test(line),
		},
		{
			// <24 hex>|<hex>: the shape of a Netatmo access token (id, bar, secret part).
			kind: "access-token-shape",
			re: /\b[0-9a-f]{24}\|[0-9a-f]{16,}/g,
		},
		{
			kind: "ticket-like-id",
			re: /\b[A-Z]{2,}-\d{2,}\b/g,
			allowed: (m) => NOT_A_TICKET_PREFIX.has(m.slice(0, m.indexOf("-"))),
		},
		{
			kind: "repository-slug",
			re: /github(?:usercontent)?\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g,
			allowed: (m) => {
				const slug = m
					.replace(/^github(?:usercontent)?\.com\//, "")
					.replace(/\.+$/, "")
					.replace(/\.git$/, "")
					.toLowerCase();
				return slug === OWN_SLUG || UPSTREAM_SLUGS.has(slug);
			},
		},
		{
			kind: "coordinate-pair",
			re: /(?<![\d.])-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}(?!\d)/g,
		},
		{
			kind: "coordinate-field",
			re: /["']?\b(?:lat|lon|lng|latitude|longitude|lat_ne|lon_ne|lat_sw|lon_sw)["']?\s*[:=]\s*-?\d{1,3}\.\d{3,}/gi,
		},
	];
}

function mask(s: string): string {
	return s.length <= 6 ? "***" : `${s.slice(0, 3)}...(${s.length} chars)`;
}

/**
 * The scanner under test. Repository slugs are matched on the text AFTER "github.com/", so the
 * allow callback receives the whole match including the host.
 */
export function scanText(text: string, file: string): Finding[] {
	const out: Finding[] = [];
	const ds = detectors();
	text.split("\n").forEach((line, i) => {
		for (const d of ds) {
			for (const m of line.matchAll(d.re)) {
				if (d.allowed?.(m[0], line, file)) continue;
				out.push({ kind: d.kind, file, line: i + 1, shown: mask(m[0]) });
			}
		}
	});
	return out;
}

// ---- which files -----------------------------------------------------------------------

const BINARY_EXT = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".pdf", ".zip", ".gz", ".woff",
	".woff2", ".ttf", ".otf", ".streamdeckplugin",
]);
const SKIPPED_NAMES = new Set(["package-lock.json", "devenv.lock"]);

function skipped(rel: string): boolean {
	const base = rel.split("/").pop() ?? rel;
	return (
		SKIPPED_NAMES.has(base) ||
		BINARY_EXT.has(extname(rel).toLowerCase()) ||
		/(^|\/)ui\/vendor\/[^/]*\.(m?js|map)$/.test(rel) // the vendored bundle
	);
}

function listFiles(): string[] {
	const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return out
		.split("\0")
		.filter((p) => p.length > 0)
		.filter((p) => existsSync(join(root, p)) && !lstatSync(join(root, p)).isSymbolicLink())
		.filter((p) => lstatSync(join(root, p)).isFile());
}

// ---- samples ----------------------------------------------------------------------------

const j = (parts: readonly (string | number)[], sep: string): string => parts.join(sep);

/** One of each format, built from parts so this file does not contain them literally. */
function badSamples(): Record<string, string> {
	return {
		"mac-address": `module ${j(["de", "ad", "be", "ef", "00", "01"], ":")} online`,
		"email-address": `contact: someone${"@"}corp${"."}test`,
		"ipv4-address": `host ${j([10, 20, 30, 40], ".")}`,
		uuid: `id ${j(["12345678", "1234", "1234", "1234", "123456789abc"], "-")}`,
		"long-hex": `key ${"a1b2c3d4".repeat(5)}`,
		"long-base64ish": `blob ${"Ab3".repeat(12)}`,
		"access-token-shape": `token ${"0123456789abcdef01234567"}|${"89abcdef".repeat(4)}`,
		"ticket-like-id": `see ${"ABC"}${"-"}${"1234"} for details`,
		"repository-slug": `https://${"github"}.com/${"someone"}/${"their-repo"}`,
		"coordinate-pair": `place: ${"48.137154"}, ${"11.576124"}`,
		"coordinate-field": `"${"lat"}": ${"48.1371"}`,
	};
}

/** Look-alikes that the allowlist must let through. */
function goodSamples(): readonly string[] {
	const maintainer = maintainerEmail();
	return [
		`mac ${j(["00", "00", "5e", "00", "53", "01"], ":")}`,
		...(maintainer ? [`contact ${maintainer}`] : []),
		`bot 41898282+github-actions[bot]${"@"}users${"."}noreply${"."}github${"."}com`,
		`ssh git${"@"}github${"."}com:owner/repo`,
		`ip ${j([192, 0, 2, 7], ".")} ${j([198, 51, 100, 7], ".")} ${j([203, 0, 113, 7], ".")} ${j([127, 0, 0, 1], ".")} ${j([0, 0, 0, 0], ".")}`,
		`"Version": "${j([0, 1, 0, 0], ".")}"`,
		`id ${j(["00000000", "0000", "0000", "0000", "000000000000"], "-")}`,
		`- uses: actions/checkout@${"0123456789abcdef".repeat(2)}01234567 # v1.2.3`,
		`repo https://github.com/${OWN_SLUG}.git`,
		`encoding UTF-8 hash SHA-256 standard RFC-5737 image icon@2x.png`,
		`version 1.2.3, ${j([300, 1, 2, 3], ".")}`,
	];
}

// ---- tests ------------------------------------------------------------------------------

test("scanner validation: every identifier format is detected in a built-in sample", () => {
	const samples = badSamples();
	const expectedKinds = detectors().map((d) => d.kind);
	for (const kind of expectedKinds) {
		assert.ok(samples[kind], `no sample for detector "${kind}": add one`);
		const found = scanText(samples[kind], "sample.txt").map((f) => f.kind);
		assert.ok(found.includes(kind), `detector "${kind}" did not fire on its own sample`);
	}
	assert.equal(new Set(Object.keys(samples)).size, expectedKinds.length, "sample/detector lists diverged");
});

test("scanner validation: allowed look-alikes are not reported", () => {
	for (const line of goodSamples()) {
		assert.deepEqual(scanText(line, "sample.txt"), [], `false positive on: ${mask(line)}`);
	}
});

test("scanner validation: findings are masked", () => {
	const [f] = scanText(badSamples()["long-hex"] ?? "", "x");
	assert.ok(f);
	assert.ok(!f.shown.includes("a1b2c3d4a1b2"), "the finding must not echo the identifier");
});

test("repository scan: no identifier-shaped data in any tracked or untracked file", () => {
	const files = listFiles().filter((p) => !skipped(p));
	let scannedFiles = 0;
	let scannedLines = 0;
	const findings: Finding[] = [];
	for (const rel of files) {
		const buf = readFileSync(join(root, rel));
		if (buf.includes(0)) continue; // binary content under a text-looking name
		const text = buf.toString("utf8");
		scannedFiles++;
		scannedLines += text.split("\n").length;
		findings.push(...scanText(text, rel));
	}
	// A scan that saw (almost) nothing proves nothing.
	assert.ok(files.includes("README.md") && files.includes("package.json"), "file listing misses core files");
	assert.ok(scannedFiles > 20, `scanner only looked at ${scannedFiles} files`);
	assert.ok(scannedLines > 500, `scanner only looked at ${scannedLines} lines`);
	assert.deepEqual(
		findings.map((f) => `${f.file}:${f.line} ${f.kind} ${f.shown}`),
		[],
		`identifier-shaped data found (scanned ${scannedFiles} files, ${scannedLines} lines). ` +
			"Replace with placeholders (see CONTRIBUTING.md); do not widen the allowlist to silence this.",
	);
});

// ---- secret scanner configuration (.gitleaks.toml) -------------------------------------------

const readRoot = (rel: string): string => readFileSync(join(root, rel), "utf8");

function gitleaksAvailable(): boolean {
	try {
		execFileSync("gitleaks", ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Stage `files` in a scratch repository and run the exact command of the pre-commit hook. */
function gitleaksStaged(files: Record<string, string>): { leaks: number; output: string } {
	const dir = mkdtempSync(join(tmpdir(), "hws-gitleaks-"));
	try {
		const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
		writeFileSync(join(dir, ".gitleaks.toml"), readRoot(".gitleaks.toml"));
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, rel)), { recursive: true });
			writeFileSync(join(dir, rel), body);
		}
		execFileSync("git", ["init", "-q", "."], { cwd: dir, env });
		execFileSync("git", ["add", "-A"], { cwd: dir, env });
		try {
			const out = execFileSync(
				"gitleaks",
				["git", "--staged", "--no-banner", "--redact", "--config", ".gitleaks.toml", "-v"],
				{ cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
			return { leaks: 0, output: out };
		} catch (e) {
			const err = e as { status?: number; stdout?: string; stderr?: string };
			assert.equal(err.status, 1, `gitleaks failed to run (exit ${err.status}): ${err.stderr ?? ""}`);
			const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
			return { leaks: (output.match(/^RuleID:/gm) ?? []).length, output };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const sentinelTests = ["tests/station-no-secret-logging.test.ts", "tests/station-redact.test.ts"];

test("gitleaks config: allowlist needs BOTH the two test paths AND the sentinel regex; hook uses the file", () => {
	const toml = readRoot(".gitleaks.toml");
	assert.match(toml, /useDefault\s*=\s*true/, "the default rules must stay on");
	assert.match(toml, /condition\s*=\s*"AND"/, "path and regex must both be required");
	assert.match(toml, /paths\s*=/);
	assert.match(toml, /regexes\s*=/);
	assert.equal((toml.match(/\[\[allowlists\]\]/g) ?? []).length, 1, "exactly one allowlist entry; widen only with a written reason");
	assert.doesNotMatch(toml, /^\s*(?:commits|stopwords)\s*=/m, "no commit or stopword escape hatches");
	// The hooks go through the wrapper, which extends .gitleaks.toml and adds the local secret values.
	const nix = readRoot("devenv.nix");
	assert.match(nix, /gitleaks-local-secrets\.py --staged/, "the pre-commit hook must use the wrapper");
	assert.match(nix, /gitleaks-local-secrets\.py --history/, "the pre-push hook must scan the history too");
	assert.match(readRoot("scripts/gitleaks-local-secrets.py"), /\.gitleaks\.toml/, "the wrapper must extend the project's config");
	for (const f of sentinelTests) assert.ok(existsSync(join(root, f)), `${f} named in .gitleaks.toml does not exist`);
});

test(
	"gitleaks: the repository's fake sentinels pass, a real-looking token in src/ or elsewhere is still caught",
	{ skip: gitleaksAvailable() ? false : "gitleaks is not on the PATH (it is inside `devenv shell`)" },
	() => {
		// Built from parts: this file is scanned by gitleaks and by the hygiene scan itself.
		const realLooking = `${"gh"}${"p_"}${["R7xK2mQ9vLp4", "Zt8WnB3cYd6H", "jF1sGa0UeXoV"].join("")}`;
		const genericKey = `api_key = "${["Zk3Qm9Xv2Lp7", "Wn4Bc8Yd1Hj6", "Fs0GaUeRtO5i"].join("")}"`;
		const sentinel = `const CLIENT_SECRET = "${"CS"}-distinctive-9f3a1c77d2";`;

		const clean = gitleaksStaged(Object.fromEntries(sentinelTests.map((f) => [f, `${sentinel}\n`])));
		assert.equal(clean.leaks, 0, `the sentinels must be allowed in their own tests:\n${clean.output}`);

		const planted = gitleaksStaged({ "src/leak.ts": `export const t = "${realLooking}";\n` });
		assert.ok(planted.leaks >= 1, "a real-looking token in src/ must still be reported");

		const wrongFile = gitleaksStaged({ "tests/other.test.ts": `${sentinel}\n${genericKey}\n` });
		assert.ok(wrongFile.leaks >= 1, "the allowlist must not extend to other files");

		const sameFile = gitleaksStaged({ [sentinelTests[1] ?? ""]: `${sentinel}\n${genericKey}\n` });
		assert.ok(sameFile.leaks >= 1, "a non-sentinel secret inside an allowlisted file must still be reported");
	},
);

// ---- repository files that must be tracked, or ignored, on purpose ----------------------------

function isIgnored(rel: string): boolean {
	try {
		execFileSync("git", ["check-ignore", "-q", "--no-index", rel], { cwd: root, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// ---- Trojan Source: invisible and bidirectional characters ------------------------------------

// U+061C, U+200B-U+200F, U+2028/2029, U+202A-U+202E, U+2060-U+2069, U+FEFF
const INVISIBLE = /[\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/u;
const TEXT_EXT = new Set([".ts", ".js", ".mjs", ".json", ".md", ".html", ".css", ".nix", ".yaml", ".yml", ".toml", ".py"]);

test("scanner validation: every invisible or bidirectional class is detected", () => {
	for (const cp of [0x061c, 0x200b, 0x200d, 0x200e, 0x200f, 0x2028, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff]) {
		assert.match(`const a = "x${String.fromCodePoint(cp)}y";`, INVISIBLE, `U+${cp.toString(16)} not detected`);
	}
	assert.doesNotMatch("const a = \"x\\u202ey\"; // escaped, visible", INVISIBLE);
	assert.doesNotMatch("Gr\u00f6\u00dfe \u2013 \u00b0C", INVISIBLE, "ordinary non-ASCII text stays legal");
});

test("no source or doc contains invisible or bidirectional characters (write them as \\u escapes)", () => {
	const problems: string[] = [];
	let seen = 0;
	for (const rel of listFiles()) {
		if (!TEXT_EXT.has(extname(rel).toLowerCase()) || skipped(rel)) continue;
		seen++;
		const text = readFileSync(join(root, rel), "utf8");
		const m = INVISIBLE.exec(text);
		if (m) problems.push(`${rel}:${text.slice(0, m.index).split("\n").length} U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
	}
	assert.ok(seen > 80, `only ${seen} text files seen, the scan may be blind`);
	assert.deepEqual(problems, []);
});

test("the pre-commit hook rejects the same characters", () => {
	const nix = readRoot("devenv.nix");
	assert.match(nix, /INVISIBLE = re\.compile\(/);
	for (const part of ["\\u202a-\\u202e", "\\u2060-\\u2069", "\\u200b-\\u200f", "\\ufeff"]) assert.ok(nix.includes(part), `hook lacks ${part}`);
});

test(".envrc is part of the repository (not ignored), .gitignore covers raw captures and generated licence files", () => {
	assert.ok(existsSync(join(root, ".envrc")), ".envrc is missing");
	assert.equal(isIgnored(".envrc"), false, "a fresh clone needs .envrc; direnv allow is documented");
	assert.equal(isIgnored("x.raw.json"), true, "raw API captures (account data) must be ignored");
	assert.equal(isIgnored("raw-capture.json"), true);
	assert.equal(isIgnored(".capture/a.json"), true);
	for (const f of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt"]) {
		assert.equal(
			isIgnored(`de.schwetschke.sd.home-weather-station.sdPlugin/${f}`),
			true,
			`${f} is generated into the plugin folder by the build and must not be committed`,
		);
	}
	assert.equal(isIgnored("tests/fixtures/station/stations-full.json"), false, "anonymised fixtures stay tracked");
	assert.equal(isIgnored("LICENSE"), false, "the root LICENSE stays tracked");
});

test("devenv.nix: no template leftovers", () => {
	const nix = readRoot("devenv.nix");
	assert.doesNotMatch(nix, /GREET|scripts\.hello|hello from/);
	assert.doesNotMatch(nix, /git --version \| grep/, "enterTest is still the template stub");
});

// ---- claims that were wrong once and must not come back --------------------------------------

test("docs make no claim that review found false", () => {
	const readme = readRoot("README.md");
	assert.doesNotMatch(readme, /never causes its own API call/i, "a key press asks for a rate-limited refresh");
	assert.match(readme, /at most one real API request per minute/);
	assert.doesNotMatch(readme, /absolute pressure \(with trend\)/i, "absolute pressure is not displayable");
	assert.match(readme, /http:\/\/localhost:53682\/callback/, "README must name the redirect URI of the browser sign-in");
	assert.match(readme, /Clear the title/i, "README troubleshooting must cover the custom key title");
	assert.doesNotMatch(readRoot("docs/ARCHITECTURE.md"), /\(verified path\)/);
	assert.doesNotMatch(readRoot("docs/SETUP.md"), /treats as verified/);
	assert.doesNotMatch(readRoot("SECURITY.md"), /\[to verify|collaboration|other contributors wrote/i);
	for (const f of ["assets/final/README.md", "docs/RENDERING.md", "NOTICE"]) {
		const text = readRoot(f);
		assert.doesNotMatch(text, /reviewed by hand|Reviewed artwork/i, `${f} presents an AI-only review as a human one`);
		assert.match(text, /maintainer/i, `${f} must say that the maintainer has not looked at the artwork yet`);
	}
	// The rotation text must describe the real behaviour (see src/adapter/station/token-manager.ts header).
	assert.doesNotMatch(readRoot("SECURITY.md"), /no attempt to "keep going"/);
	assert.match(readRoot("SECURITY.md"), /keeps the new pair in memory/);
});

// ---- claims the third review found false ----------------------------------------------------

test("docs: getmeasure type names, units/freshness location, budget numbers and security statements", () => {
	const readme = readRoot("README.md");
	const arch = readRoot("docs/ARCHITECTURE.md");
	const sec = readRoot("SECURITY.md");
	const setup = readRoot("docs/SETUP.md");
	// the request sends the spec's lowercase type names
	assert.doesNotMatch(readme, /letter case from the spelling/);
	assert.doesNotMatch(arch, /temperature to Temperature|WindStrength\./);
	assert.match(arch, /`windstrength`/);
	// the poller is not the only component that talks to the API; units and freshness are not adapter code
	assert.doesNotMatch(arch, /owns the only network traffic/);
	assert.doesNotMatch(arch, /units, freshness, poller/);
	assert.doesNotMatch(arch, /writeKeyImage/);
	assert.match(arch, /history-strip\.json/);
	assert.match(arch, /BUDGET_POLLER_RESERVE/);
	assert.doesNotMatch(arch, /No new secret-carrying message/);
	// histories exist for all but two metrics
	assert.doesNotMatch(readme, /trends, min\/max and angles do not/);
	// the rotated pair is saved as soon as the refresh worked, not only when the data load worked too
	assert.doesNotMatch(setup, /Only if both\s+succeed are the credentials written/);
	assert.doesNotMatch(readme, /checks them with one real request before it\s+keeps anything/i);
	assert.match(setup, /Saved, but/);
	// Clear and revocation, the fixed port, the credential messages
	assert.match(setup, /Clear does\s+not revoke anything at Netatmo/);
	assert.match(sec, /does not revoke the tokens at Netatmo/);
	assert.match(sec, /startBrowserLogin/);
	assert.match(sec, /TRACE[^.]*frame/i);
	assert.match(sec, /\[::1\]/);
	assert.doesNotMatch(sec, /Secrets cross the Property Inspector exactly once/);
	// provenance: claimed only as far as it was actually checked (release v0.1.1: genuine file verified, tampered copy failed)
	assert.match(sec, /attest/i);
	assert.doesNotMatch(sec, /\(\*\*not implemented\*\*\)/);
	assert.match(sec.replace(/\s+/g, " "), /checked on release v0\.1\.1: the genuine file verified, a copy with one byte appended failed/);
	assert.doesNotMatch(sec, /no release exists yet/);
	// no maintainer-specific or ticket-like repository slug in the dry-run example
	assert.match(readRoot("docs/PUBLISHING.md"), /--repo-url=<owner>\/<repo>/);
	assert.match(readRoot("docs/PUBLISHING.md").replace(/\s+/g, " "), /expected to install it \*\*\[unverified\]\*\*/);
	// README: the nav-key faces, the build route that needs devenv
	for (const face of ["One station", "No other sensor", "Only one value", "No module"]) assert.ok(readme.includes(`\`${face}\``), `README troubleshooting lacks ${face}`);
	assert.match(readme, /npm i -g tsx/);
	// NOTICE lists what the bundle really inlines
	const notice = readRoot("NOTICE");
	for (const pkg of ["@elgato/streamdeck", "@elgato/schemas", "@elgato/utils", "ws ", "zod", "tslib"]) assert.ok(notice.includes(pkg), `NOTICE lacks ${pkg}`);
});

// ---- decisions of the focus/history change ---------------------------------------------------

test("docs describe the real persist-failure behaviour and the redaction limit", () => {
	for (const f of ["SECURITY.md", "docs/ARCHITECTURE.md", "docs/SETUP.md", "README.md"]) {
		assert.doesNotMatch(readRoot(f), /Nothing is\s+shown to you|not shown to the user yet|no silent fallback/i, `${f} states the old behaviour`);
	}
	assert.match(readRoot("docs/ARCHITECTURE.md"), /UNPERSISTED_ROTATION_MESSAGE/);
	assert.match(readRoot("docs/ARCHITECTURE.md"), /every poll/);
	assert.match(readRoot("SECURITY.md"), /every poll/);
	assert.match(readRoot("SECURITY.md"), /truncated in\s+the middle/);
	assert.match(readRoot("docs/ARCHITECTURE.md"), /truncated in\s+the\s+middle/);
	assert.doesNotMatch(readRoot("SECURITY.md"), /\[to verify/i);
});

test("README states what reload can and cannot do", () => {
	const readme = readRoot("README.md");
	assert.match(readme, /cannot force the station to measure/);
	assert.match(readme, /about every 10 minutes/);
	// the names users see in the Stream Deck app (manifest Name), including the seven measurement keys
	for (const word of ["Temperature, Humidity, CO2", "Focus Display", "Reload", "Next Value", "Next Sensor", "Next Station", "Auto Rotate", "Data Age and Battery", "History", "Weather Dial"]) {
		assert.ok(readme.includes(`| ${word}`), `README actions table lacks ${word}`);
	}
	assert.match(readme, /Alerts are not an action/);
	assert.match(readme, /Every action has the account section/);
});

test("the focus and history design lives only in ARCHITECTURE.md", () => {
	const arch = readRoot("docs/ARCHITECTURE.md");
	for (const h of ["## Focus and navigation", "## History", "## API budget"]) assert.ok(arch.includes(h), `ARCHITECTURE.md lacks ${h}`);
	assert.match(arch, /500 requests per hour/);
	// the former pointer file is gone; nothing may cite it or its section numbers any more
	assert.equal(existsSync(join(root, "docs/FOCUS-AND-HISTORY.md")), false, "docs/FOCUS-AND-HISTORY.md was deleted on purpose");
	let seen = 0;
	const citing: string[] = [];
	for (const rel of listFiles()) {
		if (skipped(rel) || !TEXT_EXT.has(extname(rel).toLowerCase())) continue;
		seen++;
		if (rel !== "tests/repo-hygiene.test.ts" && readFileSync(join(root, rel), "utf8").includes("FOCUS-AND-HISTORY")) citing.push(rel);
	}
	assert.ok(seen > 80, `only ${seen} text files seen, the scan may be blind`);
	assert.deepEqual(citing, []);
});

test("secretspec.toml carries the verified provider sequence and marks 1Password UNVERIFIED", () => {
	const toml = readRoot("secretspec.toml");
	assert.match(toml, /SECRETSPEC_PROVIDER="dotenv:/);
	assert.match(toml, /UNVERIFIED/);
	assert.match(toml, /config global provider add onepassword/);
	assert.doesNotMatch(toml, /secretspec config provider add/, "the old, incomplete sequence");
});

test("docs describe what the code does: info key, status rows, rotation message place, SECURITY lists every PI page", () => {
	const readme = readRoot("README.md");
	const arch = readRoot("docs/ARCHITECTURE.md");
	// the info key has no radio-signal page (src/render/nav-view.ts infoPages)
	assert.doesNotMatch(readme, /radio signal \(if/i);
	assert.doesNotMatch(arch, /signal \(if reported\)/i);
	assert.match(readme, /Data Age and Battery/);
	// the unsaved-rotation warning: status line of the Property Inspector AND a marker on the keys
	for (const f of ["README.md", "SECURITY.md", "docs/SETUP.md", "docs/ARCHITECTURE.md", "CLAUDE.md"]) {
		const text = readRoot(f).replace(/\s+/g, " ");
		assert.match(text, /Property Inspector/, f);
		assert.match(text, /warning marker/, `${f} must say that the keys carry a warning marker`);
		assert.doesNotMatch(text, /deck itself gives no signal|gives no signal/, `${f} states the old behaviour (message only in the Property Inspector)`);
		assert.doesNotMatch(text, /`error` (?:ConnectionState|connection state)/, `${f} describes the old error encoding of the rotation warning`);
	}
	assert.doesNotMatch(readme, /\| Key shows a message that the renewed sign-in/);
	// status table rows
	for (const word of ["Offline", "Pick module", "No data"]) assert.ok(arch.includes(`\`${word}\``), `ARCHITECTURE status table lacks ${word}`);
	// install claims that nobody verified carry the marker
	assert.match(readme.replace(/\s+/g, " "), /DRM[^.]*\*\*\[unverified/);
	assert.match(readRoot("docs/PUBLISHING.md").replace(/\s+/g, " "), /DRM[^.]*\*\*\[unverified\]\*\*/);
	assert.match(readme.replace(/\s+/g, " "), /not\s+tried|was not tried/);
	// brand validation was neither requested nor received
	assert.match(readme.replace(/\s+/g, " "), /written validation[\s\S]*?None was requested/);
	// fixture command: two steps, no bare capture:fixture under secretspec
	assert.doesNotMatch(readme, /secretspec run -- npm run capture:fixture/);
	assert.match(readme, /--raw-out/);
	// SECURITY.md names every Property Inspector page
	const uiDir = join(root, "de.schwetschke.sd.home-weather-station.sdPlugin", "ui");
	const pages = readdirSync(uiDir).filter((f) => f.endsWith(".html"));
	assert.ok(pages.length >= 6, `only ${pages.length} PI pages seen, the listing may be blind`);
	const sec = readRoot("SECURITY.md");
	for (const page of pages) assert.ok(sec.includes(page), `SECURITY.md CSP section does not list ${page}`);
	// accepted advisories are documented where the exception lives
	assert.match(sec, /osv-scanner\.toml/);
	assert.ok(existsSync(join(root, "osv-scanner.toml")));
});

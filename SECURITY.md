# Security

This plugin holds OAuth credentials for a Netatmo developer app and the account's token
pair. This file states what is stored where, who can read it, and what the plugin does and
does not defend against. **[unverified]** marks statements that need hardware, Windows or
the live service and have not been tested there. The live service has been reached once, by
the maintainer's probe script on 2026-11-13 (one account, structure only; see
[docs/WEATHER-API.md](docs/WEATHER-API.md)): its token refresh worked and the rotated token
was stored. That run did not exercise revocation, the browser sign-in, the portal's token
generator or Windows, so those statements stay **[unverified]**. The statements about the
code were checked against the source.

## Reporting a vulnerability

Please report privately, not in a public issue:

- Use GitHub's private vulnerability reporting for this repository
  (the "Report a vulnerability" button on the Security tab of this repository), or
- write to the maintainer address in `package.json` (`author`).

Do not include live tokens or client secrets in a report. If you leaked your own, revoke
them first (delete the app in the Netatmo developer portal; regenerating its secret is the
usual way to revoke it, but whether that also invalidates issued tokens is **[unverified]**). This is a
hobby project: expect a reply within a couple of weeks, not hours. No bounty.

## Supported versions

Only the latest release is supported. Pre-1.0 releases may change storage format; the
changelog says so when it happens.

## What is stored where

| Data | Where | Who can read it | Protection |
|---|---|---|---|
| Client id, client secret, access token, refresh token | `credentials.json` in the per-user data directory (paths in [docs/SETUP.md](docs/SETUP.md)) | Every process running as your OS user, backups of that directory, administrators | File mode `0600` on macOS/Linux, atomic write (temp file + rename). **Not encrypted.** On Windows the mode is ignored and the profile's access control list applies **[unverified]**: the suite has not been run on Windows |
| Choice of module, metric, units, labels, poll interval, alert thresholds, the navigation focus (`moduleKey`, station and module ids, which are MAC addresses) | Stream Deck settings (plain JSON in your Stream Deck profile) | Same as above, plus anything that exports or syncs Stream Deck profiles **[unverified]** | None. **Contains no secrets by design.** |
| Latest station snapshot and history curves | Memory only | The plugin process | Memory only; the plugin writes no data file other than `credentials.json` (the Stream Deck SDK writes the log files) |
| Logs | The plugin's `logs` folder | Same as above | No tokens, secrets, Authorization headers, query strings or raw API bodies; module ids not at INFO (guarded by a test, see below) |

Honest limits:

- **Stream Deck settings are plaintext** and the Stream Deck SDK dumps them into the log at
  TRACE level. That is why credentials do not go there. If you ever set the plugin's
  debug mode (`npm run watch`), the SDK flips to TRACE logging and opens a Node inspector
  port; debug mode makes TRACE reachable, it does not force it (the level comes from the environment variable
  `HOME_WEATHER_LOG_LEVEL`, default `info`). Never attach such logs to an issue and never ship a build with debug enabled.
  At TRACE the SDK logs every frame, **including the message that carries your client id and
  secret** (`setCredentials` or `startBrowserLogin`); the plugin's redaction covers only the
  adapter's own loggers, not the SDK's frame dump.
- The plugin-level error handlers (uncaught exception, unhandled rejection, the router's
  failure paths) log through the SDK logger and may include a raw stack trace, which the
  redaction does not see. They do not put tokens into the message on purpose, but that is
  not proven for every possible error text.
  Releases must not contain `Nodejs.Debug` in the manifest (checked by the build tooling and a
  pre-commit hook).
- The credentials file is as safe as your user account. Malware running as you can read it
  and can also read the Stream Deck app's data. Full-disk encryption protects only a powered-off
  machine.
- The refresh token grants read access to your station data (scope `read_station`), not
  control of devices and not access to cameras or thermostats. The client secret
  belongs to an app that only you own. **"Clear" in the Property Inspector only deletes the
  local file; it does not revoke the tokens at Netatmo.** Revoking by regenerating the app's
  secret or deleting the app in the developer portal is **[unverified]**: nobody has tried
  whether issued tokens then stop working.
- Netatmo may change the API, the token lifetimes or the portal at any time.

## Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Token or secret in logs / issue reports | Redaction rules (best effort: known secrets in raw, URL-encoded, JSON-escaped and base64 form and common `key=value` patterns; a secret that was truncated in the middle is **not** caught), no logging of headers, query strings or API bodies, a test that feeds known secrets through the logger and the client (`tests/station-no-secret-logging.test.ts`); the issue template tells reporters not to paste tokens | Users pasting unredacted logs; TRACE logs under debug mode |
| Token in Stream Deck settings or profile exports | Credentials are never put into settings; the Property Inspector sees only a summary (client id hint, state) | None by design |
| Another local user reads the file | `0600`, per-user directory | Same-user malware; Windows ACL semantics |
| Remote content running in the Property Inspector | Property Inspector CSP; sdpi-components and Lit are vendored, not loaded from a CDN (see below) | A compromised vendored bundle |
| API strings (station or module names) used for injection | Treated as untrusted text: escaped or kept out of SVG, passed through the native title, truncated for logs | Parser or renderer bugs; fuzzing is not part of this project yet |
| Malicious or oversized API response | Response size cap (2 MiB) and explicit shape validation in the client | A compromised Netatmo endpoint or TLS interception with a trusted CA |
| Supply chain (npm, GitHub Actions) | Actions pinned to full commit SHAs and checked in CI, Dependabot with a 14-day cooldown, lockfile, `osv-scanner` in CI and pre-push, lockfile-only installs (`npm ci`); two advisories are accepted for a limited time, see "Known advisories" below | New dependencies are trusted at install time; tests do not prove their behaviour |
| Another client invalidates the token | Documented (docs/SETUP.md); auth errors stop polling instead of retry loops | See failure mode below |
| Local webhook or listener abuse | The plugin never registers webhooks. The experimental browser sign-in opens a loopback listener for at most three minutes and only for one callback | The port is fixed (53682) and the plugin listens on `127.0.0.1` only, while the redirect URI says `localhost`. A local process that binds the port first, or listens on `[::1]` where the browser resolves `localhost` to IPv6, can receive the authorization code; it cannot exchange it without the client secret, and the plugin only accepts a callback with the exact random `state` value (constant-time comparison) |

### Property Inspector: CSP and vendoring

The Property Inspector is a small web page opened by the Stream Deck app. It loads its UI
library from the plugin folder and runs only scripts that ship in the plugin. The shipped
pages (every file in `ui/*.html`: `measurement.html`, `dial.html`, `dial-sensor.html`, `dial-value.html`, `focus.html`,
`history.html`, `auto-rotate.html`, `info.html`, `navigation.html`,
`sensor-focus.html`; `tests/repo-hygiene.test.ts` compares this list with the
directory) carry this policy as a `<meta>` tag:
`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src ws://127.0.0.1:* ws://localhost:*; base-uri 'none'; form-action 'none'`.
So there is no inline script (init code lives in `ui/init/*.js`), the only connection allowed
is the app's loopback WebSocket, and there are no remote origins. Inline styles are allowed
(`'unsafe-inline'` for styles only), because the vendored component library needs them.
Vendoring sdpi-components (and the Lit it contains) means opening the inspector never
contacts a third-party server and never executes code that changed after review. The price
is manual updates: see `de.schwetschke.sd.home-weather-station.sdPlugin/ui/vendor/VENDORED.md`
for versions and the update procedure.

Secrets cross the Property Inspector from the form to the plugin process in two messages,
`setCredentials` (client id, secret, refresh token) and `startBrowserLogin` (client id and
secret); nothing secret is ever sent back to it, and the form clears the secret fields after
each press.

### Known advisories (osv-scanner)

`osv-scanner.toml` lists two accepted advisories, each with a reason and an expiry date
(`ignoreUntil`, 2027-02-11); after that the gate fails again until someone re-reviews them:

- `GHSA-mrhx-c7xc-m3w5` (zod 3.25.76, CVSS 8.2 per osv-scanner, fixed in 4.6.6): zod is a
  dependency of `@elgato/utils` 0.6.0 (via `@elgato/streamdeck` 2.1.2) and is bundled into the
  plugin. The SDK declares `zod ^3.25.24`, so the fixed 4.x line is outside its range. As
  checked on 2026-11-13, the newest `@elgato/utils` (0.6.2) still declares `^3.25.24`; no
  patched release within the SDK's range exists. The advisory is a memory-exhaustion
  problem for very large collections handed to zod; the plugin validates only small local
  Stream Deck messages and Netatmo responses capped at 2 MiB. Whether that reasoning holds
  was not tested **[unverified]**. Exact upgrade once the SDK allows it: raise
  `@elgato/streamdeck`, check `npm ls zod` shows >= 4.6.6, run the full tests and the
  bundle test, then delete the entry.
- `GHSA-gcqx-w48m-w2h4` (deepmerge 4.3.1, no fixed version, CVSS 5.3): dev dependency of
  `@rollup/plugin-node-resolve`, used at build time on our own sources only, not shipped.

### Failure mode: rotation loss

Netatmo invalidates the previous refresh token on every refresh. The plugin therefore
refreshes through a single request at a time and tries to write the new token pair to disk
(two attempts, atomic rename) before it hands out the new access token. What it cannot
prevent:

- another program refreshing with the same token (the plugin shows `Sign in`),
- the machine losing power between Netatmo issuing the new pair and the file rename
  completing,
- a disk that is full or read-only at that moment.

What happens when the write fails is deliberate and not a silent success (implemented in
`src/adapter/station/token-manager.ts`):

1. The write is attempted twice; each failure is logged at error level (error code only).
2. The plugin keeps the new pair in memory (the old token is already dead, so discarding it
   would break the running session for nothing) and carries on with current data.
3. It publishes an `ok` connection state with the warning `unpersisted-rotation` and the
   message "The renewed sign-in could not be saved to disk. Data is current, but after a
   restart you will have to sign in again.". The plugin shows it in the account status of the
   Property Inspector and as a warning marker on the keys (a warning-coloured dot on the key
   tile; on the dial a "!" and a warning-coloured indicator bar). The values stay at full opacity;
   when data is also stale, the stale look wins.
4. The write is retried on every poll; on success the message disappears.
5. If the plugin or the machine restarts before a write has succeeded, the disk still holds
   the dead token and the next start shows `Sign in`; the recovery is a new authorisation.
   The plugin never retries a rejected token.

## Supply chain of the project itself

Pinned and approved workflow actions, a read-only default token, secret scanning with push
protection, osv-scanner and zizmor in CI plus a weekly scan, dependency review on pull requests,
and protected release tags are described in [docs/PUBLISHING.md](docs/PUBLISHING.md) (section
"Repository settings (as code)") and enforced by `scripts/github-settings.py`. Release assets
are built by CI from the tagged commit in two jobs: the build runs `npm ci --ignore-scripts`
with a read-only token and no write permission, a second job without checkout and without npm
holds the write token, attests the file (GitHub build-provenance attestation, signed through
the workflow's OIDC identity) and attaches it. The release carries no checksum file and no
separate signature. Verify a download with `gh attestation verify <file> --repo <owner>/<repo>`
(checked on release v0.1.1: the genuine file verified, a copy with one byte appended failed; the
attestation names this repository and `release.yml` as builder, it does not vouch for the code
itself). Download
only from the release page of this repository, never from a link in a chat message.

## What this plugin does not do

- It sends nothing to the author or any third party, and contains no telemetry or update check.
  The only network peer is the Netatmo API host.
- It does not ask for your Netatmo username or password and never stores them.
- It does not use write scopes or webhooks.
- Credentials that cannot be read (wrong permissions, damaged file) are reported with the data
  directory; the plugin does not guess, delete or overwrite them.

## For contributors

Never commit credentials, real station data or personal data; see
[CONTRIBUTING.md](CONTRIBUTING.md). `tests/repo-hygiene.test.ts` scans for identifier
formats (MAC addresses, e-mail addresses, UUID-like ids, long token-like strings, coordinates)
and `gitleaks` runs as a pre-commit hook on staged files and as a pre-push hook on the whole
history. Both go through `scripts/gitleaks-local-secrets.py`, which adds the REAL values from your
local, git-ignored `.env.local` (the secretspec dotenv file) as extra rules, in raw, URL-encoded,
base64 and JSON spellings, so a pasted token is caught even where no generic pattern would see it.
Because a refresh token rotates and the exact value is stale within hours, a second layer works
without any value: `.gitleaks-shapes.json` (committed, no value in it) describes what the secrets
look like, calibrated on the real ones with `npm run scan:calibrate` (character class and length
per part, separators, and a minimum Shannon entropy of the measured value minus 0.5 bit; hex
identifiers must match their length exactly). Any new string of that shape is reported, also in
CI. Placeholders with low entropy, commit hashes and lock-file digests are not. Known limits:
upper-case spellings of a lower-case hex token, a token split across lines, and a token in an
encoding other than raw, percent-encoded or JSON-escaped are not recognised by the shape layer.
The values are never printed and the temporary rules are deleted after the run; without
`.env.local` (for example in CI) the exact values are not checked, only the shapes and the generic
rules, and the run says so. CI scans the history that way too. `npm run scan:secrets` runs the history scan by hand. A value
that only lives in 1Password or another provider is NOT covered unless it is also in `.env.local`.
None of this is a guarantee. If a secret does get
committed, treat it as compromised: revoke it first, then clean the history.

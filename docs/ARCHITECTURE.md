# Architecture

Unofficial Stream Deck plugin ("Home Weather Station") that shows data from a Netatmo
weather station on keys and dials, with a plugin-wide focus you can navigate and a history
sparkline. Plugin id `de.schwetschke.sd.home-weather-station`; the `.sdPlugin`
folder, every action UUID prefix and the `.streamDeckPlugin` file name derive from it.
Keep the id in ONE place (`src/actions/catalog.ts` for code, `scripts/lib/plugin-id.ts`
for scripts) and never hard-code it elsewhere except `package.json` scripts and
`rollup.config.mjs`.

## Layers

```
Stream Deck app ── WebSocket ── plugin process (Node 24, one bundled file;
                                   the manifest asks for Node 24, see README for what is unverified)
                                   │
   src/plugin.ts ── registers actions, settings funnel, wires the poller
   src/actions/*     SDK layer: bind funnel, repaint-from-cache, key & dial actions
   src/focus/*       pure navigation over the focus (station, module, metric); SDK-free
   src/render/*      pure functions: snapshot + settings -> SVG string / title / feedback
                     (including the history sparkline); display units (`format.ts`) and
                     freshness / status (`status.ts`) live here
   src/adapter/station/*   SDK-FREE: credentials, token manager, HTTP client, parser,
                           history, poller, browser sign-in. Never imports @elgato/streamdeck.
   src/pi-protocol.ts      message names + shapes shared with the Property Inspector
   ui/*.html, ui/init/*.js Property Inspector (static HTML + vendored sdpi-components)
```

Why the adapter is SDK-free: importing the SDK rotates its log files as a module side
effect, which races between parallel test processes. The adapter logs through
`src/adapter/logging.ts` (`scopedLogger`); `plugin.ts` injects the SDK logger. The same
rule holds for test files.

## Data flow

1. `Poller` (one per process) owns the recurring traffic of the station data. Three other
   things also call the API: history (`getmeasure`, see "History"), the validation request after a
   save or a sign-in, and the code exchange of the browser sign-in. It starts with the first
   subscriber and stops after the last. Default interval 300 s (Netatmo refreshes
   station data about every 10 minutes); never below 60 s; jitter; exponential backoff on
   errors, capped at 1 h; honours `Retry-After`. A key press may request `refresh()`,
   which is coalesced and rate-limited (at most one real request per 60 s), never a
   per-press API call. History is the only other traffic, see "History" below.
2. `Poller` keeps the last good `StationSnapshot` and a `ConnectionState`.
3. Actions subscribe, and **repaint from the cache** — never from a query. A repaint is
   one closure shared by snapshot updates, status changes and timers.
4. Renderers are pure: `(snapshot, settings, now) -> image/title`. Freshness is computed
   from `ModuleData.measuredAt` and the clock, NOT from `reachable` (which lags real
   outages by up to 4 hours).

### Status is a pure function

What a key shows when data is old or missing is computed inside the normal render from
`ConnectionState` + `Freshness`; there is no second write path that sets "Offline" and
could outlive the outage. Display table:

| State | Key |
|---|---|
| fresh | value, normal colours |
| stale (older than 25 min) | value, dimmed, small "age" hint |
| unreachable module | dimmed icon, title `No signal` |
| error (transient, cached data) | as stale |
| auth-error | warning icon, title `Sign in` |
| no-credentials | setup icon, title `Set up` |
| loading | neutral icon, title `…` |
| value outside the key's alert threshold | alert colour (static; no blinking, see "Alerts") |
| no data source (no service) or nothing fetched yet and a cached error | `Offline` |
| fixed key without a module | `Pick module` |
| module (or focus) has no reading for the metric | `No data` |
| history without data | `No history`; while the first request runs `Loading`; failed request `Offline`; budget used up `Try later` |
| token rotation not saved | `ok` ConnectionState with `warning: "unpersisted-rotation"`; data keeps flowing and keys keep their normal face and full opacity. The warning is shown twice: the Property Inspector's account status line (the router sends `AccountStatus.warning`) and a warning marker on the keys: a warning-coloured dot on the tile, on the dial a "!" and a warning-coloured indicator bar; staleness wins when both apply (`src/render/status.ts`, `tile.ts`, `dial-feedback.ts`). The human text is the shared constant `UNPERSISTED_ROTATION_MESSAGE` |
| one failed poll | every key counts as stale (`freshness !== fresh` or a cached error) and is dimmed at once, however recent the last good data is |

## Authentication and secrets

* Each user brings their OWN Netatmo developer app (client id + secret) with scope
  `read_station`. No client id/secret ships with the plugin.
* Netatmo uses the OAuth2 authorization-code grant. The access token lives 3 h; the
  refresh token **rotates on every refresh**: the previous pair is invalidated at once.
  Therefore the token manager (a) refreshes single-flight, (b) tries to persist the new
  pair atomically (two attempts) BEFORE returning the new access token, (c) refreshes ~60 s
  early, and (d) treats `invalid_grant` / 403 code 30 as `auth-error` (stop polling, ask to
  sign in). If both persist attempts fail, the new pair is kept in memory only (the old one
  is already dead) and:
  * each failed attempt is logged at error level (error code only);
  * `hasUnpersistedRotation` turns true and the poller publishes an
    `ok` `ConnectionState` with `warning: "unpersisted-rotation"` (the text is
    `UNPERSISTED_ROTATION_MESSAGE`, exported by `src/adapter/station/token-manager.ts`). The
    router maps it to `AccountStatus` state `ok` plus `warning`, which the Property Inspector
    prints as "Connected ... Warning: <text>", and the keys show a warning marker without
    dimming; data keeps flowing;
  * the write is retried at the start of every `getAccessToken()`, i.e. on every poll; when
    it succeeds the flag and the message disappear;
  * a restart before a successful write leaves the DEAD old refresh token on disk: the next
    refresh is rejected and the user has to sign in again.
  The alternative (discarding the only valid token) would break the running session for
  nothing, which is why there is neither a silent success nor a hard stop.
* Do not share one app/refresh token between this plugin and another client (for example a
  home-automation integration): concurrent refreshes invalidate each other's token. Use a
  separate Netatmo app per client.
* Bootstrap options for the refresh token, both UNVERIFIED against the live service: the
  experimental browser sign-in with a loopback redirect (needs
  `http://localhost:53682/callback` registered in the app; behaviour of Netatmo with
  loopback URIs is not documented), or pasting a token pair that the developer portal is
  said to generate (described by community projects, absent from Netatmo's documentation,
  not inspected). See docs/SETUP.md and docs/WEATHER-API.md.
* The same rule applies when a user saves credentials or finishes the browser sign-in
  (`create-service.ts`): the rotated pair is written to disk as soon as Netatmo accepted the
  token request, BEFORE the station data request; `saved: true` therefore also holds when only
  the data load failed afterwards. When the write itself fails the result is
  `{ ok: false, saved: false, error }` and the pair is adopted into the live token manager in
  memory (same policy as above) so it is not lost.
* `setCredentials` returns `{ ok: false, saved: true | false, error }`, where `error` is the
  complete, user-facing text; the Property Inspector prints it as given. An auth failure of
  the first data request ("403, code 13", missing `read_station`) says so and does not promise
  a retry, because the poller stops on auth errors.
* Clearing: `service.clearCredentials()` rejects when the file cannot be removed (the errno
  code is logged); the router answers `clearResult { ok, error, status }` and the Property
  Inspector shows "Removing..." until then. Polling stops only when the removal worked. Clear
  does not revoke anything at Netatmo.
* A credentials file that exists but cannot be read (permissions) or parsed is a distinct
  summary (`CredentialSummary.unreadable`), shown with the data directory, not as "not
  configured".
* Storage: a `0600` JSON file in the per-user application-data directory
  (`~/Library/Application Support/home-weather-station/credentials.json`,
  `%APPDATA%\home-weather-station\`, `$XDG_CONFIG_HOME` or `~/.config/…`), written
  atomically (temp file + rename). NOT in Stream Deck settings: those are plain JSON in
  the user's profile and are dumped into the log at TRACE level.
* The PI sees only `CredentialSummary`/`AccountStatus`; secrets travel PI -> plugin in the
  `setCredentials` and `startBrowserLogin` messages and never back. One parser
  (`parseCredentialInput`) validates both messages (512 characters at most per field).
* Never log tokens, secrets, Authorization headers, URLs with query strings, module ids
  at INFO, or raw API bodies. A redaction test guards this. Redaction itself is best
  effort: it replaces secrets it knows (raw, URL-encoded, JSON-escaped, base64) and
  patterns such as `refresh_token=...`, but does NOT catch a secret that was truncated in
  the middle. The primary defence is not logging such values at all.
* Poll only. Never call `/webhooks/v1`: Netatmo allows one webhook URL per app and
  registering one would replace another client's registration.

## API facts the code relies on

See `docs/WEATHER-API.md` for the sourced details. In short: `getstationsdata` returns
`body.devices[]` (base station `NAMain` with nested `modules[]`) and
`body.user.administrative`; values are always metric; `time_utc` is the measurement time;
limits are 50 requests / 10 s and 500 / h per user (stated on Netatmo's page for the Smart
Home API; applying them to the weather API is UNVERIFIED). `getmeasure` is documented in the
same file. One live probe (2026-11-13, the maintainer's account with one station: base,
one outdoor and three additional indoor modules) confirmed `getstationsdata` with GET and
POST, both `getmeasure` response shapes with the lowercase `type`, bucket-middle timestamps
at scale 30min, epoch seconds without an hour offset for that account's time zone, and that
`Pressure` is the sea-level and `AbsolutePressure` the station-level pressure. Wind and rain
modules and their history, other time zones and scales, error codes and rate limits remain
UNVERIFIED.

## Rendering

* Key image: 144×144 SVG composed as a string, wrapped as a base64 `data:image/svg+xml`
  URI before `setImage` (a raw SVG string is silently ignored by the hardware for
  composed images; measured in the sibling project). Icons and colours only; the value
  text goes through the native key title unless `bigText` is on (SVG `<text>`, not
  verified on hardware).
* API strings (module names, station names) never enter SVG as markup: escape them, or
  better, keep them out of the SVG and use the native title.
* Quantise values to the displayed precision before composing so `writeKeyFace`
  de-duplication works and polls with jittering decimals do not rewrite the image.
* Every SDK promise is caught (`fireAndLog`): Node 24 treats unhandled rejections as fatal.
* Dial/touch strip: built-in layout `$B1` (value + indicator bar) and the custom layout
  `layouts/history-strip.json` for the mini history, content via `setFeedback`; every item gets an explicit opacity. Gestures: see "Dial mapping".

## Focus and navigation

A **focus** is the plugin-wide cursor `(stationId, moduleId, metric)`. It is stored in the
Stream Deck global settings under `focus` (no secrets) through the single writer funnel, so
it survives a restart. Pure navigation lives in `src/focus/navigate.ts` (SDK-free, tested
with a two-station fixture):

* `nextMetric(snapshot, focus, dir)`: next/previous metric that THIS module reports (stable
  order from `src/render/metrics.ts`, wraps around).
* `nextModule(snapshot, focus, dir)`: next/previous module of the same station that reports
  `focus.metric`; modules lacking it are skipped; wraps. If no other module qualifies the
  focus does not change and the result says `blocked: true` (the key flashes `showAlert`,
  nothing else).
* `nextStation(snapshot, focus, dir)`: next/previous station; lands on its base module with
  the metric kept when available, else that module's first metric.
* `resolveFocus(snapshot, stored)`: repairs a stale or missing focus (module vanished, first
  start) to the first base station's temperature. Never throws.

A focus change repaints every action that follows the focus, nothing else.

### Actions

All are keys unless noted. The seven metric presets (temperature, humidity, CO2, noise,
pressure, rain, wind) stay as fixed-binding keys.

| id | What it does |
|---|---|
| `focus` | Manifest name "Focus Display". Follows the whole focus (station, sensor AND metric); shows value and label of the focused module. Alerts are ignored (the unit changes with the metric). Press: rate-limited refresh. |
| `focus-sensor` | Manifest name "Sensor Focus". Always follows the focus's station and sensor, shows the metric of ITS OWN settings (default temperature) and ignores the focus's metric, so Next/Previous Value do not change it. Alert thresholds apply (same metric, same unit). Press: rate-limited refresh; temperature also shows today's min/max for 6 s. Own page `ui/sensor-focus.html`: no module picker, no follow checkbox. |
| `focus-refresh` | Reload: at most one real request per 60 s; shows "just now" or the age. **Cannot force the station to measure**; it only fetches the newest data the station has uploaded (about every 10 minutes). |
| `focus-next-metric`, `focus-prev-metric` | Next / previous value on the same sensor; icon and small label show the metric that WOULD be selected. |
| `focus-next-sensor`, `focus-prev-sensor` | Same value on the next / previous sensor; dimmed when no other module reports the metric. |
| `focus-next-station`, `focus-prev-station` | Next / previous station; dimmed when only one station exists. The owner has one station, so this is tested with a two-station fixture only. |
| `auto-rotate` | Toggle; advances the focus through the metrics of the focused module every N seconds (setting, default 8, range 3..60). Off at plugin start unless "start on" is ticked. The timer exists only while the key is visible and on. |
| `info` | Manifest name "Data Age and Battery". Cycles data age and battery level of the focused module (`infoPages()` in `src/render/nav-view.ts`: `age`, `battery`). There is no radio-signal page and the adapter model has no signal field. Uses snapshot data only. |
| `history` | 24 h history: cycles 6 h / 24 h / 3 d; sparkline of the focused (or, per setting, a fixed) module and metric. |
| `weather-dial` (dial) | See "Dial mapping". Follows the focus or its own pinned module (`followFocus`, default true). |

Every measurement key has the settings `followFocus`, `alertAbove` and `alertBelow`. Follow
semantics of the key controller (`effective()` in `src/actions/key-controller.ts`):

* A fixed key with `followFocus` ticked follows the focus's station and sensor but keeps its
  own metric (a CO2 key stays CO2, `No data` where the sensor lacks it); alerts stay valid.
  `focus-sensor` behaves the same, with the follow always on.
* `focus` (Focus Display) follows sensor AND metric and ignores alerts.
* `history` and `weather-dial` follow the whole focus by default (`followFocus` default true);
  off pins them to their own module and metric.
* Sensor and station navigation (keys, dial push and push-rotate) move the sensor focus;
  next/previous metric (keys, dial rotation) move the metric focus.

### Alerts

`alertAbove` / `alertBelow` are in display units of the key's unit system. Outside the
range the tile uses the alert colour. It is a static colour on purpose: blinking is an
accessibility risk and was left out.

### Dial mapping

| Gesture | Effect |
|---|---|
| rotate | next / previous value (`nextMetric`) |
| push | next sensor (`nextModule(+1)`) |
| rotate while pushed | next / previous station (`nextStation`) |
| touch tap | reload (rate-limited) |
| long touch | toggle min/max (temperature) / 24 h mini history on the strip |

A pinned dial (`followFocus` false) changes only its own state, not the focus.

Behaviour on hardware (key flash, dial push-rotate, touch long press) is UNVERIFIED: no
Stream Deck hardware was available.

## History

* `WeatherService.getHistory(request)`, request `{ stationId, moduleId, metric, window }`
  with window `"6h" | "24h" | "3d"`; result `{ kind: "ok", request, points: {t, v}[], stepMs, fetchedAt }` (t in epoch ms;
  there is no `unit` field) or an error result (`src/adapter/station/history.ts`). It calls `GET /api/getmeasure` with `device_id`
  (base station id), `module_id` (omitted for the base module), `scale` (30min for 6h/24h,
  1hour for 3d, so at most 72 points), `type`, `date_begin`/`date_end` and `optimize=true`. Response shapes and
  units: docs/WEATHER-API.md. Both shapes, the lowercase `type`, 48 points for 24 h and the
  bucket-middle timestamps were confirmed by the live probe of 2026-11-13 (one account with
  one station, base-station temperature only); scale 1hour (3d, rain), wind and rain
  series and other time zones are UNVERIFIED.
* Metric to type (the spec's lowercase spelling, `MEASURE_SPECS` in `history-parse.ts`):
  temperature, humidity, co2, noise, pressure as named; rain to `sum_rain` (scale 1hour,
  drawn as bars); wind to `windstrength`. The metrics without a history are "Station pressure"
  (`absolutePressure`) and Gusts; the History key and the dial page answer `No history` for
  them, and the Property Inspector's metric list for the History key offers only metrics
  that have one.
* Rendering: `src/render/sparkline.ts` (pure) draws a 144x144 SVG; no API strings in markup,
  gaps stay gaps (no interpolation across more than 2 steps), coordinates are quantised so
  image de-duplication works. Empty or error states follow the display table.

## API budget

History shares the rate budget of the client and the same token manager (single-flight
refresh). Limits: 500 requests per hour and 50 per 10 s per user (UNVERIFIED for the weather
API, see above). What the plugin does to stay far below:

* the poller makes one request per 300 s by default (12 per hour), never below 60 s;
* reload makes at most one real request per 60 s, however often pressed;
* history is fetched only for visible actions, cached per station|module|metric|window for 10
  minutes (`HISTORY_CACHE_TTL_MS`; stations upload that often), failures are remembered for
  30 s (`HISTORY_MIN_INTERVAL_MS`; for a rate-limit answer until its `Retry-After`, at most 10 min) so they are not retried at once, concurrent requests are
  coalesced, and the key retries a failed request after 60 s (`HISTORY_RETRY_MS` in
  `src/actions/history-slot.ts`);
* there are no webhooks and no background history prefetch.

Numbers: the poller at its 60 s floor is 60 requests per hour, at the default 12; every
visible history key and window adds about 6 per hour (one per 10-minute cache lifetime). Optional
traffic (history) is refused once 400 of the 500 hourly requests are used
(`BUDGET_POLLER_RESERVE` in `src/adapter/station/budget.ts` keeps 100 for the poller). The
total depends on how many history keys are visible at once; the plugin never gets near 500
under normal use.

## Settings

* The settings types are narrower than what the Property Inspector stores (it stores
  strings, for example `alertAbove`); readers parse them (`focus/settings.ts`).
* Per action: `MeasurementSettings` (module, metric, unit override, `followFocus`,
  `alertAbove`, `alertBelow`, `historyWindow`, `autoRotateSeconds`, `autoRotateStartOn`, …)
  in `src/pi-protocol.ts`. Settings carry no secrets (the credentials messages are separate
  and never stored). The Property Inspector has no read-out of the current focus. In
  `moduleKey`, an empty string means the user deliberately cleared it (the key then says
  `Pick module`); only an absent value adopts a module automatically.
* Global: `GlobalSettings` (poll interval, unit system) and `focus` (no secrets). One writer funnel
  (`updateGlobalSettings`), gated on a successful initial load; `plugin.ts` is the only
  caller of `setGlobalSettings` (a test greps for it). No secrets.
* The PI never uses sdpi's `global` binding; it reads/writes through `sendToPlugin`.

## Manifest, versions, releases

* `manifest.json` is generated by `scripts/generate-manifest.ts` from the action catalog,
  so UUIDs in code and manifest cannot drift. `Nodejs.Debug` must be ABSENT in everything
  committed or packed (never `"disabled"`); `npm run watch` adds `"enabled"` locally.
* Manifest `Version` is 4-part, derived from `package.json` by `scripts/sync-manifest-version.ts`.
* release-please + Conventional Commits drive versions and the changelog.
* Distribution: GitHub Releases (`.streamDeckPlugin` asset) only. Deliberately NOT on the
  Elgato Marketplace (see docs/BRANDING.md).

## Brand hygiene (enforced by tests)

* `Netatmo`, `Elgato`, `Stream Deck`, `Plugin` do not appear in manifest `Name`, `Category`,
  `Author`, `UUID`, file or folder names, or icons.
* "Netatmo" appears only as a compatibility statement in running text, together with the
  non-affiliation notice.
* No Netatmo logo, product photo, brand colour as identity, or "works with" badge.
* No third-party personal data or internal infrastructure identifiers in the repo; test
  fixtures are anonymised and `tests/repo-hygiene.test.ts` scans for identifier *formats*
  (MAC addresses, e-mail addresses, UUID-like ids, private IPs, coordinates), not just
  keywords.

## Testing

`node --test tests/*.test.ts` with native type stripping: no enums, no constructor
parameter properties, `.ts` extensions in all relative imports. The HTTP client is tested
against a local `node:http` double (`baseUrl` is injectable). Pure renderers get unit
tests; a bundle test checks that the built `bin/plugin.js` loads and registers (it looks
for a log marker, not an exit code, and has a negative control).

## Considered and deferred

Two refactorings from the type review were not done and are not forgotten: a `Secret`
wrapper class for tokens (so that `String()` or JSON serialisation cannot leak one) and
branded types for station, module and device ids. Both are cross-cutting; the current
defences (the redacting logger, a test that feeds known secrets through every logger,
no secrets in settings) hold without them.

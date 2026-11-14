# Weather station API notes

Notes on the Netatmo Connect API (weather stations), distilled for contributors of this unofficial plugin. It is a compatibility note, not
documentation of the service: the plugin is independent and not affiliated with, endorsed
by or sponsored by Netatmo.

## How to read the status column

| Status | Meaning |
|---|---|
| **VERIFIED (docs)** | Read in Netatmo's own developer documentation or OpenAPI document, fetched live on 2026-11-13 |
| **VERIFIED (probe)** | Observed in an unauthenticated probe with bogus credentials on 2026-11-13 (no personal data involved) |
| **VERIFIED (code)** | Read in the source of Home Assistant or pyatmo (pins below); shows what works in production there, not what Netatmo promises |
| **VERIFIED (live probe 2026-11-13, one account with one station)** | Observed by the maintainer with `npm run probe -- --history` against their own account: one station, five modules (base station, one outdoor module, three additional indoor modules; no wind gauge, no rain gauge). The probe prints structure only, no ids, names, coordinates or values. One account in one time zone: true there, not proven for every account |
| **UNVERIFIED** | Inference, community report or general knowledge; not covered by the live probe above |

**Authenticated evidence is limited to one live probe** (2026-11-13, the maintainer's own
account with one station; rows marked "live probe"). Everything else in this file comes from
documents, code of other projects or the unauthenticated probe. In particular wind and rain
modules, other time zones, other `getmeasure` scales and all error paths were not exercised.
`npm run probe` (see below) closes more gaps when someone with a different station runs it.

Sources:

* Official docs (the developer portal is a JavaScript app; the text was read from the JSON
  endpoints the portal itself calls): <https://dev.netatmo.com/apidocumentation/oauth>,
  <https://dev.netatmo.com/apidocumentation/weather>,
  <https://dev.netatmo.com/apidocumentation/general>,
  <https://dev.netatmo.com/guideline>, <https://dev.netatmo.com/legal>.
  The weather OpenAPI document is "Netatmo - Weather" v1.1.2.
* Home Assistant core, integration `netatmo` (the `homeassistant/components/netatmo` directory of the
  Home Assistant core repository, read in November 2026). The exact commit is deliberately not
  recorded here; re-read the current upstream source before relying on a detail.
* pyatmo 9.9.1 (the library that integration uses; published on PyPI as `pyatmo`).

## Authentication

| Claim | Status |
|---|---|
| Only the authorization-code grant is documented. Authorize: `GET https://api.netatmo.com/oauth2/authorize` (`client_id`, `redirect_uri`, `scope`, `state`). Token: `POST https://api.netatmo.com/oauth2/token`, `application/x-www-form-urlencoded;charset=UTF-8` | VERIFIED (docs) |
| Refresh: `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`. Code exchange: `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `redirect_uri`, `scope` | VERIFIED (docs) |
| Response fields `access_token`, `refresh_token`, `expires_in` (docs example 10800 = 3 h) | VERIFIED (docs) |
| Token format `<24 hex>\|<32 hex>` (used only as a redaction pattern) | VERIFIED (docs) |
| The refresh token ROTATES: "former values are immediately invalidated and can't be reused" | VERIFIED (docs). A live refresh with these parameters worked and the probe stored the rotated token: VERIFIED (live probe 2026-11-13, one account with one station). That the OLD token is then rejected was not tried |
| Rotation became effective 2023-04-17 (community-quoted notice) | UNVERIFIED (secondary source) |
| A lost rotated token can only be recovered by a new authorisation; there is no grace period | UNVERIFIED (nothing documented: assumed) |
| Refresh-token lifetime / inactivity expiry | UNVERIFIED (docs only say "expired or revoked") |
| Scope for this plugin: `read_station` only. Default scope when none is sent: `read_station`. Needs no Netatmo approval (only `access_*` scopes do) | VERIFIED (docs) |
| Client credentials grant (username/password) is gone: `unsupported_grant_type` | VERIFIED (probe) |
| Bogus refresh probe: `400 {"error":"invalid_client"}`; without a token `getstationsdata` answers `400 {"error":{"code":1,"message":"Access token is missing"}}` | VERIFIED (probe) |
| Storing user credentials is forbidden; only the token pair may be stored | VERIFIED (docs, guideline) |
| PKCE is accepted or ignored | UNVERIFIED (not mentioned in the docs) |
| A loopback redirect `http://localhost:<port>/callback` is accepted (HA's docs tell users NOT to register a redirect URI, which suggests arbitrary ones work) | UNVERIFIED |
| The developer portal can generate an access/refresh token pair for your own app (used as the bootstrap path) | UNVERIFIED (not in the docs; described by community projects; the "My apps" page needs a login) |

Decisions in code: tokens are refreshed 60 s early (`REFRESH_MARGIN_MS`; HA uses 20 s),
single flight, the rotated pair is persisted atomically before use, a rejected refresh
token is never sent again (`token-manager.ts`). Every user brings their own app; the
`client_secret` is stored in a 0600 file and never logged. The docs ask that the secret be "stored server-side only"; a desktop plugin cannot honour that literally, which is why no
secret ships with the plugin.

## Endpoint: getstationsdata

| Claim | Status |
|---|---|
| `GET https://api.netatmo.com/api/getstationsdata`, scope `read_station`, query `device_id` (optional, marked deprecated), `get_favorites` (default false) | VERIFIED (docs) |
| pyatmo sends a POST with form parameters instead, and sets `get_favorites` true by default | VERIFIED (code) |
| GET (what the plugin sends) works; POST (what pyatmo sends) is accepted and returns the same structure | VERIFIED (live probe 2026-11-13, one account with one station) |
| Envelope `{status, time_exec, time_server, body:{devices:[...], user:{...}}}`; base station `NAMain` with nested `modules[]` | VERIFIED (docs) |
| Station and module fields: see the table below | VERIFIED (docs) |
| Data in the cloud "are updated every 10min" | VERIFIED (docs) |
| `/homestatus` gives "near realtime" weather data | UNVERIFIED (the weather spec has no matching schema) |
| `get_favorites=true` returns public stations with outdoor data only | VERIFIED (docs); the plugin always sends `false` |

Request used by the plugin: `GET /api/getstationsdata?get_favorites=false` with
`Authorization: Bearer <access_token>`.

### Modules and measurements

| Type | Product | Plugin role | `dashboard_data` keys | Status |
|---|---|---|---|---|
| `NAMain` | base station | `base` | `Temperature`, `Humidity`, `CO2`, `Noise`, `Pressure`, `AbsolutePressure`, `min_temp`, `max_temp`, `temp_trend`, `pressure_trend`, `time_utc` | VERIFIED (docs) |
| `NAModule1` | outdoor module | `outdoor` | `Temperature`, `Humidity`, `min_temp`, `max_temp`, `temp_trend`, `time_utc` | VERIFIED (docs) |
| `NAModule2` | anemometer | `wind` | `WindStrength`, `WindAngle`, `GustStrength`, `GustAngle`, `max_wind_str`, `max_wind_angle`, `time_utc` | VERIFIED (docs) |
| `NAModule3` | rain gauge | `rain` | `Rain`, `sum_rain_1`, `sum_rain_24`, `time_utc` | VERIFIED (docs) |
| `NAModule4` | additional indoor module | `indoor-extra` | `Temperature`, `Humidity`, `CO2`, `min_temp`, `max_temp`, `temp_trend`, `time_utc` | VERIFIED (docs) |
| `NHC` | Healthy Home Coach | not supported | separate endpoint `gethomecoachsdata`, scope `read_homecoach` | VERIFIED (code) |

Real module mix seen by the live probe (2026-11-13, one account with one station): one
`NAMain` plus one `NAModule1` and three `NAModule4`, all reachable. Observed `dashboard_data`
keys, as the table above says, plus `date_min_temp` and `date_max_temp` on every temperature
module: `NAMain` `AbsolutePressure`, `CO2`, `Humidity`, `Noise`, `Pressure`, `Temperature`,
`min_temp`/`max_temp`, `pressure_trend`, `temp_trend`, `time_utc`; `NAModule1` `Humidity`,
`Temperature`, min/max, `temp_trend`, `time_utc`; each `NAModule4` the same plus `CO2`.
`battery_percent` was absent on the base station and present on every module. Several
`NAModule4` on one station therefore occur in practice. `NAModule2` (wind) and `NAModule3`
(rain) were not present, so their rows above stay documentation-only. A station without
any module and an account without stations (does the API then omit `devices`?) were not
seen either (UNVERIFIED).

Other module fields: `battery_percent` ("10 = low"), `battery_vp`, `rf_status`
(90 low, 60 highest), `wifi_status` on the base (86 bad, 56 good), `reachable`, `last_seen`,
`last_message` (VERIFIED, docs). Units are metric regardless of the account setting
(VERIFIED, docs; HA declares metric native units). Whether values ever follow the account
unit setting: UNVERIFIED in the docs, but the spec's examples are metric and HA relies on it.

The parser ignores everything not listed, drops values that are not finite numbers in a
plausible range, and never copies `user.mail`, `place`, `home_id` (personal data).

### Pressure vs AbsolutePressure

The OpenAPI document describes `Pressure` as "surface pressure" and `AbsolutePressure` as
"sea-level pressure". Both research reports considered this swapped in practice. The live
probe settles it the other way round from the spec text: at an elevated station `Pressure`
was LARGER than `AbsolutePressure`, so `Pressure` is the sea-level (reduced) pressure and
`AbsolutePressure` the station-level pressure. VERIFIED (live probe 2026-11-13, one account
with one station). One station is enough to be physically unambiguous (above sea level the
reduced value always exceeds the station value), but it is still one station. Home Assistant
exposes `Pressure` only.

In code (`src/adapter/station/parse.ts`) the keys map one-to-one (`Pressure` to `pressure`,
`AbsolutePressure` to `absolutePressure`). The display labels are "Pressure" and
"Station pressure" (`src/render/metrics.ts`). Which of the two fields `pressure_trend` describes is
not documented and was not checked (UNVERIFIED); the plugin shows the trend on "Pressure"
only. `npm run probe` prints which key is larger for a station above 50 m, without numbers;
if another station ever reports "SWAPPED", re-open this section.

### Freshness

`reachable` means "connected to the cloud within the last 4 hours" (VERIFIED, docs), so it
lags outages. Neither pyatmo nor Home Assistant looks at `time_utc` (VERIFIED, code). This
plugin derives freshness from `dashboard_data.time_utc`: older than 25 minutes (two missed
10-minute cycles; our choice, `STALE_AFTER_MS` in `src/render/status.ts`) is stale.

## Endpoint: getmeasure (history)

Used by the history key (docs/ARCHITECTURE.md, sections "History" and "API budget"). Parameters,
`type` names and the timestamp rule were read from the live OpenAPI spec of the Weather API on
2026-11-13 (a document, not a response). The live probe of the same day (`npm run probe -- --history`,
one account with one station) then requested 24 h of `temperature` of the base station at scale
`30min`, once with `optimize=true` and once with `optimize=false`, and settled the rows marked
"live probe" below: lowercase `type`, both response shapes, the bucket-middle timestamps and
epoch seconds without an hour offset. It did not cover wind or rain history, other modules,
other scales (`1hour`, so the 3-day window and rain), other time zones or any error path.
The fixtures `tests/fixtures/station/measure-optimised.json` and `measure-plain.json` are still
**spec-derived, not captured** (invented values; their shapes match what the probe reported).

| Claim | Status |
|---|---|
| `GET https://api.netatmo.com/api/getmeasure`, scope `read_station` | VERIFIED (OpenAPI spec: "retrieve station (dataGetstationsdata, Getmeasure)"); an authenticated call with this scope worked: VERIFIED (live probe 2026-11-13, one account with one station) |
| Parameters: `device_id` (base station MAC, required), `scale` (required), `type` (required, comma separated list), `module_id` (optional: absent means the base module), `date_begin`, `date_end` ("Local Unix time in seconds" in the spec), `limit` (default and max 1024), `optimize` (default true), `real_time` (default false) | VERIFIED as written in the OpenAPI spec (2026-11-13); behaviour for the base module without `module_id` VERIFIED (live probe 2026-11-13, one account with one station); `module_id` and `limit` behaviour UNVERIFIED |
| `date_begin`/`date_end` are plain epoch seconds (UTC-based), despite the spec's "Local Unix time": the returned timestamps lined up with the request window and the server clock (clock skew 0 s, last point = `date_end` - 900 s at scale 30min), no whole-hour offset | VERIFIED (live probe 2026-11-13, one account with one station) for that account's time zone; other time zones were not tried (UNVERIFIED) |
| Scales: `30min`, `1hour`, `3hours`, `1day`, `1week`, `1month` (the spec enum has no `max`, although the `real_time` description mentions it; the plugin does not use it) | VERIFIED (OpenAPI spec enum) |
| `type` values are LOWERCASE in the spec: `temperature`, `humidity`, `co2`, `noise`, `pressure`, `rain`, `sum_rain`, `windstrength`, `windangle`, `guststrength`, `gustangle`, plus `min_*`/`max_*`/`date_min_*`/`date_max_*` variants (date variants only for scales 1day to 1month; not used). Which modules report which type: base `temperature`, `co2`, `humidity`, `noise`, `pressure`; outdoor `temperature`, `humidity`; additional indoor `temperature`, `co2`, `humidity`; rain gauge `sum_rain`; anemometer `windstrength` (+ angle/gust). The plugin sends exactly these spellings, one table (`MEASURE_SPECS` in `history-parse.ts`, pinned by `tests/station-history.test.ts`). Earlier drafts sent the capitalised dashboard spelling (`Temperature`, `CO2`, `WindStrength`) from memory; whether the service also accepts that spelling was not tried (UNVERIFIED) and is not relied on | VERIFIED (OpenAPI spec, 2026-11-13) for the spelling; the service accepts lowercase `temperature` for the base station: VERIFIED (live probe 2026-11-13, one account with one station); the other types, and the module-to-type assignment, are UNVERIFIED live (recalled, pyatmo; in particular `sum_rain` and `windstrength`, because the station has no rain or wind module). Pressure unit is "bar" in the spec, almost certainly a typo for mbar (UNVERIFIED) |
| Plugin mapping: temperature, humidity, co2, noise, pressure as named; rain = `sum_rain` with scale `1hour`; wind = `windstrength`. Of the values a key can display, "Station pressure" (`AbsolutePressure`) and gusts have no history key; the history key offers only the seven metrics above | our decision (`history-parse.ts`) |
| Request used: `device_id`, `module_id` (non-base only), `scale` (`30min` for 6 h and 24 h, `1hour` for 3 d and for rain), `type`, `date_begin`, `date_end` (now), `optimize=true`, `real_time=false` | our decision; the exact query string is pinned by `tests/station-history.test.ts` |
| Optimised shape: `body: [ { beg_time, step_time, value: [[v], [v], ...] }, ... ]`; `value` rows hold one number per requested type | VERIFIED (live probe 2026-11-13, one account with one station): an array of chunks with `step_time`, parsed by `parseMeasureBody` |
| A new chunk starts after a gap (rather than `null` rows) | UNVERIFIED: the probed 24 h had no gap (one chunk, 48 rows) |
| Non-optimised shape: `body: { "<epoch seconds>": [v], ... }` | VERIFIED (live probe 2026-11-13, one account with one station): an object keyed by epoch seconds, 48 rows, parsed by `parseMeasureBody` |
| 24 h at scale `30min` gives 48 points | VERIFIED (live probe 2026-11-13, one account with one station): 48 points in both shapes, step 1800 s, no holes, about 100 % of the window covered |
| **Timestamp meaning.** With `real_time=false` the spec says returned timestamps are "offset + scale/2", i.e. the MIDDLE of the bucket. Both `beg_time` (optimised) and the keys (plain) follow that rule: at scale 1800 s the first point was `date_begin` + 900 s and the last `date_end` - 900 s, `(t - date_begin) mod scale` = 900 s | VERIFIED (live probe 2026-11-13, one account with one station) for scale `30min`; other scales UNVERIFIED |
| `step_time` is present in every chunk (the parser tolerates its absence for a chunk with one value) | VERIFIED for the one chunk the probe saw (live probe 2026-11-13, one account with one station); a chunk with one value was not seen |
| `null` cells occur for missing buckets | UNVERIFIED: the probed window had no holes (the parser treats `null` as a hole) |
| Values come in metric units regardless of the account setting (same as getstationsdata); rain `sum_rain` is mm per bucket | Temperature in the range class -40..60 (degrees Celsius) with account `unit=0` (metric): VERIFIED (live probe 2026-11-13, one account with one station); an imperial account and rain are UNVERIFIED |
| Data are as fresh as the 10 minute upload cycle; `real_time=true` would add the newest value | UNVERIFIED (not used) |
| Rate limits and error codes are the ones of getstationsdata (401/403 expired, 403 code 26, 429, 5xx) | UNVERIFIED for this endpoint (shared client code path) |
| `date_begin` older than the retention of the chosen scale, or an empty range, yields an empty body rather than an error | UNVERIFIED |

**Definition of `HistoryPoint.t`**: the timestamp exactly as the API reports it, unshifted, which
is the bucket middle (spec, confirmed by the live probe for scale `30min`, see above). A consumer
treats the bucket as `[t - stepMs/2, t + stepMs/2)`; the sparkline draws with `bucketAnchor`
"middle". In the probe the first point lay exactly `stepMs/2` after `date_begin` and the newest
`stepMs/2` before `date_end`. The code does not rely on that alignment: a consumer still allows
the newest point to lie up to `stepMs/2` after the request's end time and the first up to
`stepMs/2` before `date_begin`. If a later probe shows bucket starts for another scale, change
this paragraph, the comment in `types.ts` and (if wanted) shift in `parseMeasureBody`.

Plugin behaviour (code: `src/adapter/station/history.ts`, `history-parse.ts`, `budget.ts`):

* Strict parsing with bounds: at most 2000 points and 400 chunks; timestamps must be epoch
  seconds; a non-number value rejects the whole response (shown as a transient error), a
  finite number outside the plausible range of the metric is dropped like a hole.
* Cache of 10 minutes per (station, module, metric, window); concurrent identical requests
  share one HTTP call; a failure is remembered for 30 s (a rate-limit failure until its
  `Retry-After`, at most 10 minutes), so one key triggers at most one real request per 30 s.
* The request budget (50 per 10 s, 500 per hour) is counted locally and shared with the
  poller; history is refused when 100 requests of the hourly budget would be left for the
  poller. A 429 is not slept through for history, it is reported at once (reason `rate`).
* Credentials cleared or replaced: in-flight requests are aborted, their result is
  discarded, the cache is dropped.

## Units and display preferences

| Claim | Status |
|---|---|
| `body.user.administrative`: `unit` 0 metric / 1 imperial; `windunit` 0 kph, 1 mph, 2 m/s, 3 beaufort, 4 knot; `pressureunit` 0 mbar, 1 inHg, 2 mmHg; `feel_like_algo` 0 humidex / 1 heat-index; `lang`, `reg_locale`, `country` | VERIFIED (docs) |
| `homesdata` carries the same data under `unit_system`, `unit_wind`, `unit_pressure` | VERIFIED (code); not used here |
| `feel_like_algo` only names the algorithm; no computed value is delivered | VERIFIED (code: no hit in HA/pyatmo); the plugin does not show "feels like" |
| Beaufort thresholds used by Netatmo's apps | UNVERIFIED. `src/render/format.ts` uses the standard WMO table in km/h (lower bounds of force 1 to 12: 1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118; pinned by `tests/render-beaufort.test.ts`). Decision: keep it |

Conversions (physical constants, not from Netatmo): degC to degF `c*9/5+32`; mbar to inHg
`*0.0295299830714`; mbar to mmHg `*0.750061682704`; km/h to mph `/1.609344`, to m/s `/3.6`,
to knots `/1.852`; mm to in `/25.4`. Rounding and number format live in `src/render/format.ts`. The
number format follows `reg_locale` (falls back to `lang`), with a fixed `.` fallback.

## Errors

API errors are `{"error":{"code":n,"message":"..."}}`; OAuth errors are
`{"error":"invalid_grant","error_description":"..."}` (VERIFIED, docs). The client never copies
either body into messages or logs.

| HTTP / code | Meaning (docs) | Plugin behaviour | Status |
|---|---|---|---|
| 401 code 2 / 3 | invalid / expired access token | refresh once, retry once | VERIFIED (docs) |
| 403 code 3 | expired access token | same | VERIFIED (docs lists it); which of 401/403 a live expiry produces is UNVERIFIED, both are handled |
| 403 code 30 | invalid refresh token | auth error: stop polling, ask for sign-in | VERIFIED (docs) |
| 400 `invalid_grant`, `invalid_request` on the token endpoint | refresh token rejected / request invalid | auth error | VERIFIED (docs) |
| Any other 4xx on the token endpoint (bare 401/403/404, HTML page, `unsupported_grant_type`, `invalid_scope`, empty 400) | does not say that the credentials are bad | protocol error: retried with backoff (cap 1 h), NOT sticky; only the bodies named in the rows above stop polling | our decision; the OAuth RFC 6749 section 5.2 error names (`invalid_client`, `unauthorized_client`) are treated like the documented ones |
| 403 code 26 on the token endpoint | usage limit | rate-limited, 10 min pause (same as the data endpoint) | our choice |
| 403 code 13 | operation forbidden | auth error (probably missing scope) | VERIFIED (docs); the scope interpretation is UNVERIFIED |
| 403 code 26 / 429 codes 26, 28, 29 | usage / rate limit | rate-limited; `Retry-After` honoured; 403/26 pauses 10 min (our choice) | VERIFIED (docs) |
| 406 code 5 | application deactivated | auth error (check the app) | VERIFIED (docs) |
| 5xx, timeout, network | outage | transient, exponential backoff capped at 1 h | VERIFIED (docs lists 5xx); a multi-hour outage on 2026-05-02/03 was reported by community: UNVERIFIED |

`Retry-After` may be delta-seconds or an HTTP date (RFC 9110); up to 60 s is waited inside the
request, longer values are handed to the poller as `retryAt`.

## Rate limits

Per user 50 requests per 10 s and 500 per hour; per app `min(2 * users, 200)` per 10 s and a
user-count dependent hourly quota (VERIFIED, docs, guideline page). The text says "Smart Home
API"; that it applies to the Weather API too is UNVERIFIED. A single-user app is bound by 500
per hour. The poller asks every 300 s (12 per hour, clamped 60 to 3600 s) with +-10 % jitter,
and never twice within 60 s. Do not share one app/token pair with another client such as
Home Assistant: rotation makes them invalidate each other.

## Webhooks: deliberately not used

Netatmo allows one webhook URL per application and must reach a public HTTPS endpoint; a
desktop plugin has neither, and registering one would replace another client's registration
(VERIFIED, docs and code). The plugin only polls and never calls `/webhooks/v1`.

## Terms of use relevant to a public repository (VERIFIED, docs, legal page)

* Only non-commercial use of the Weather API is acceptable; commercial use needs written
  authorisation. This is a free, open-source plugin.
* The API key must stay confidential: no `client_id`/`client_secret` is ever committed or
  shipped; each user registers their own app.
* Do not redistribute Netatmo data: test fixtures are synthetic or anonymised
  (`npm run capture:fixture`).
* Using the word "Netatmo" needs care (descriptive compatibility statement only, no logo,
  no confusing name). Branding is covered in `docs/BRANDING.md`.

## How to close the open questions

```bash
secretspec run -- npm run probe -- --raw-out /path/outside/the/repo/raw.json   # refused inside the repo unless git ignores the path; never overwrites; 0600
npm run capture:fixture -- /path/outside/the/repo/raw.json --name my-station
```

The probe refreshes (rotating the token, which it persists before anything else), calls
getstationsdata with GET and POST, and prints structure only: module types, metric keys,
data ages, unit preferences, the pressure-key finding. With `--history` it also requests
24 h of temperature of the first base module (optimised and plain) and prints the response
shape, chunk and point counts, step, null holes and a value range class (no values). Use a token pair that is NOT used by
the installed plugin or any other client. Update the status column above with what it reports.

The maintainer ran `npm run probe -- --history` once, on 2026-11-13, against their own account
(one station; the rows marked "live probe"). In that run the refresh worked and the rotated
token was written back through secretspec. Still open, and most useful from a station that
differs: wind and rain modules and their history (`windstrength`, `sum_rain` at scale `1hour`),
another time zone, the capitalised `type` spelling, a station without modules, an account
without stations, `getmeasure` error codes and rate limits.

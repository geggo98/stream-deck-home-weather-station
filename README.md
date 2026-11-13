# Home Weather Station

> **Unofficial plugin.** This is an independent, community-made plugin for Stream Deck.
> It is not affiliated with, and not made, authorised, sponsored, endorsed or supported
> by Netatmo, Legrand, Elgato or Corsair. "Netatmo" is a trademark of its owner.
> "Stream Deck" and "Elgato" are trademarks of Corsair Memory, Inc. These names appear
> only to describe which weather station and which software the plugin works with.

Shows live readings from your own Netatmo weather station on Stream Deck keys and dials:
temperature, humidity, CO2, noise, pressure, rain, wind and trends.

Status: early development. Nothing in this repository has been tested against the live
Netatmo service or on Stream Deck hardware yet unless a section below says so. Claims that
are not verified are marked **[unverified]**. The 24 h history key is the least verified
part: its request and response shapes come from the public specification, its fixtures are
invented, and the type names it sends differ in letter case from the spelling in the
specification (whether that matters is untested, see docs/WEATHER-API.md).

## What it does

- One key (or dial) per measurement. You pick the module (indoor base station, outdoor
  module, wind gauge, rain gauge, extra indoor modules) and the metric in the Property
  Inspector.
- Colour and icon follow the value; the number itself is the native key title.
- If data gets old the key dims and shows its age. If a module is unreachable it says so.
  Freshness is computed from the measurement timestamp, not from the API's `reachable`
  flag, which can lag an outage by hours (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).
- Navigate with keys or the dial (see Actions): the plugin keeps one focus (station,
  sensor, value) that all following keys show.
- One poller for all keys: the API is queried every 5 minutes by default, with backoff on
  errors. Pressing a key asks for a refresh; that request is joined with a poll that is
  already running and is rate-limited to at most one real API request per minute, however
  often you press.

### Actions

Stations upload about every 10 minutes, so no key can be "more live" than that.

| Action | Key press / dial gesture |
|---|---|
| Focus display | Shows the value of the current focus (station, sensor, value). Press: refresh. |
| Reload | Fetches the newest data from the cloud now. **It cannot force the station to measure a new value**; it only fetches what the station has uploaded last (about every 10 minutes). At most one real request per minute, however often you press. Shows "just now" or the age. |
| Next value / previous value | Next value on the same sensor (for example temperature, then humidity, then CO2 of the same module). |
| Next sensor / previous sensor | The same value on the next sensor (for example indoor temperature, then outdoor temperature). Dimmed when no other sensor reports it. |
| Next station / previous station | The next weather station on your account. Dimmed with one station. Tested with a two-station fixture only, because the author owns one. |
| Auto rotate | Toggle: steps through the values of the focused sensor every few seconds (default 8, 3 to 60). Runs only while the key is visible. |
| Info (manifest name "Data Age and Battery") | Cycles data age and battery level of the focused sensor (where it reports one). There is no radio-signal page. |
| 24 h history | Day curve of the focused value; each press cycles 6 h, 24 h and 3 days. Needs one extra API request per visible key, cached for 10 minutes. |
| Alerts | Every measurement key can have an upper and a lower threshold; outside it the key uses the alert colour (static, it does not blink). |
| Dial | Rotate: next value. Push: next sensor. Rotate while pushed: next station. Touch tap: reload. Long touch: min/max (temperature) or the 24 h mini history. |

Which keys follow the focus is a setting per key ("follow focus"); fixed keys keep their
module and metric. None of this has been tried on Stream Deck hardware yet
**[unverified]**.

### Supported metrics

Temperature (with min/max and trend), humidity, CO2, noise, pressure (with trend), rain
(current, last hour, last 24 hours), wind speed and direction, gust speed and direction.
The API delivers two pressure fields; "Station pressure" is a selectable metric for the second one. Nobody has checked on live data which of the two is the sea-level value, so the labels do not claim it **[unverified]**.
Healthy Home Coach and other Netatmo product lines are not supported, only the weather
station and its modules. Units follow your Netatmo account preferences unless you override them.
Which of these a given module delivers depends on the module type.

## Install

Releases are published on GitHub only, on the Releases page of this repository. A release
exists once that page lists a `de.schwetschke.sd.home-weather-station.streamDeckPlugin`
file; until then there is nothing to download and you build it yourself (section
Development: `npm run build`, then `npm run pack`).

1. Download the `.streamDeckPlugin` file from the latest release.
2. Double-click it. The Stream Deck app is expected to offer to install it **[unverified]**.
3. Sideloading is expected to work because the packed file is a plain plugin package without
   DRM **[unverified: an author claim, not tested]**. Installing a self-built pack was not
   tried, neither on a Stream Deck app nor on hardware. The plugin is not published on the
   Elgato Marketplace on purpose, see [docs/PUBLISHING.md](docs/PUBLISHING.md).

Requirements: Stream Deck app 7.1 or newer (the value of `Software.MinimumVersion` in
`manifest.json`; Elgato's manifest reference uses 7.1 together with Node.js 24 in its
example, but does not say that 7.1 is the first version that bundles Node.js 24, so treat
the exact minimum and the Node.js 24 runtime on the user's machine as **[unverified]**), macOS 12 or Windows 10 or newer as declared in the
manifest. Dials need a Stream Deck with dials (Stream Deck +); keys work on any model.
Whether it also runs in OpenDeck is **[unverified]**.

The release page carries no checksum or signature at the moment. Download only from the
releases page of this repository.

## Set up

You need your own Netatmo developer app; no client id or secret ships with the plugin.
Nobody has run the whole procedure below against the live Netatmo service yet, so the
steps that depend on Netatmo's portal or login are marked **[unverified]**. Details and
pitfalls: [docs/SETUP.md](docs/SETUP.md).

The route we recommend trying first (experimental browser sign-in):

1. Create an app at <https://dev.netatmo.com> and note its client id and client secret. Where
   the portal asks for scopes, tick **only `read_station`** (see docs/SETUP.md, section 2, for why
   nothing else is needed).
2. In that app's settings, register the redirect URI `http://localhost:53682/callback`
   exactly like this (the Property Inspector shows the address the plugin will use)
   **[unverified: nobody has confirmed that the portal has such a field or that Netatmo
   accepts a loopback address]**.
3. Add any key of this plugin in the Stream Deck app, paste client id and client secret
   into the Property Inspector and press "Sign in with browser". Your browser opens
   Netatmo's login; after you approve, the plugin receives the code on the loopback
   address and stores the resulting tokens. It checks them with one real request before it
   keeps anything.

If Netatmo refuses the redirect, fall back to pasting a token pair (client id, client
secret and **refresh token**) into the same form. How to obtain that pair is the other
open question: the developer portal is said to offer a token generator for your own app
**[unverified: described by community projects, absent from Netatmo's documentation, not
inspected by us]**.

How you can help verify: try the route above with your own account and report which step
worked or failed in an issue, quoting only the visible message. Do not paste client
secrets, tokens, MAC addresses or station names.

Where credentials live: a `0600` JSON file in the per-user application-data directory
(see [docs/SETUP.md](docs/SETUP.md)), not in Stream Deck settings, which are plain
text. Details and limits in [SECURITY.md](SECURITY.md).

Do not use the same Netatmo app or refresh token in this plugin and in another program (for
example a home-automation integration). Netatmo rotates the refresh token on every refresh
and invalidates the old one, so two clients sharing one token keep logging each other out.
Create a separate app for each client.

## Privacy

- Your tokens and weather data stay on your computer. The plugin talks to the Netatmo API
  host and to nothing else; there is no telemetry, no update check, no server of the author.
- The only places data is written: the credentials file, Stream Deck's own settings (module
  and metric choices, no secrets) and the plugin's log files (no tokens, see SECURITY.md).
- Station and module ids are MAC addresses. Do not paste them, logs or screenshots with them
  into public issues.

## Non-commercial use only

Netatmo's API terms allow only non-commercial use of the Weather API, and Netatmo may
change or restrict the API at any time. Therefore this plugin is free, has no ads, no paid
tier and no donation links, and must not be used commercially. Brand rules and the
reasoning are in [docs/BRANDING.md](docs/BRANDING.md) (not legal advice).

Netatmo's terms ask for written validation of any use of its brand. None was requested and
none was received; the draft request is in docs/BRANDING.md and was **not sent**. This
repository relies on plain compatibility wording only.
Use at your own risk, without warranty (see [LICENSE](LICENSE)).

## Troubleshooting

| What you see | Meaning and what to do |
|---|---|
| Key says `Set up` | No credentials stored. Open the Property Inspector and enter them. |
| Key says `Sign in` | Netatmo rejected the refresh token (revoked, or invalidated because another client refreshed with it, or the rotated token was lost). Enter a fresh token pair. |
| Key says `No signal` | The module is not reporting (battery, radio range, base station offline). Check it in Netatmo's own app. |
| Value is dimmed with an age | Data is older than 25 minutes. Netatmo stations report about every 10 minutes; a short outage or a network problem is the usual cause. |
| The Property Inspector's account status says the renewed sign-in could not be saved | Netatmo issued a new refresh token and writing it to disk failed twice (disk full or read-only?). Data is current, the plugin retries the write on every poll and the message disappears on success. The keys keep showing the last good data and look normal: **the deck itself gives no signal**, the message appears only in the account status of the Property Inspector. If you restart before the write succeeds, you have to sign in again. |
| History key says `No history` | No data for that sensor and window, or the metric has no history (trends, min/max and angles do not). |
| History key says `Offline` or `Try later` | The history request failed (network or server trouble) or the request budget is used up. Failures are remembered for 30 seconds, successful results for 10 minutes; the key retries about every minute. |
| Key says `Offline` | Nothing could be fetched yet and there is no cached data (network trouble), or the plugin has no data source. |
| Key says `Pick module` or `No data` | A fixed key has no module chosen, or the chosen module reports nothing for that metric yet. |
| Key shows `...` for long | First poll still running or the network is down. The plugin retries with backoff. |
| The number is missing, only the icon shows | A custom title typed into the key in the Stream Deck app hides the plugin's value (the plugin cannot override it). Clear the title field in the app, or switch on the "Large value" option in the Property Inspector (**[unverified]** on hardware whether that avoids the problem; clearing the title is the safe fix). |
| Key shows the default icon only | The plugin may not be running. Restart the Stream Deck app. After repeated crashes the app marks a plugin unstable and stops starting it; only restarting the app clears that (observed in a sibling project, **[unverified]** here). |

Plugin logs are written to the plugin's `logs` folder inside the installed plugin directory
(on macOS `~/Library/Application Support/com.elgato.StreamDeck/Plugins/de.schwetschke.sd.home-weather-station.sdPlugin/logs`,
on Windows `%APPDATA%\Elgato\StreamDeck\Plugins\de.schwetschke.sd.home-weather-station.sdPlugin\logs`;
these paths are the usual Stream Deck locations and **[unverified]** for this plugin).
For public bug reports redact them first, see the issue template.

## Development

Tooling is provided by [devenv](https://devenv.sh) (Node.js 24, tsx, pinact, osv-scanner).

```sh
devenv shell                 # or `direnv allow` (the repository tracks .envrc)
npm ci
npm run typecheck
npm test                     # node --test, native type stripping
npm run build                # sync version, bundle to the plugin folder
npm run validate             # Stream Deck CLI manifest validation
npm run pack                 # produces the .streamDeckPlugin file
npm run watch                # rebuild + restart, adds Nodejs.Debug locally (never commit it)
```

Credentials for the probe script are read through
[secretspec](https://secretspec.dev) (version 0.21 tested); `secretspec.toml` names the three
variables. A secretspec provider has to be selected first, otherwise `set` fails with
"No provider backend configured". Two ways were tried in a scratch home directory.
Because an agent session needs a reason for every access, export `SECRETSPEC_REASON`
(any short text) when you run these from one.

Verified with the `dotenv` provider (a plain file, ignored by `.gitignore`; not encrypted):

```sh
export SECRETSPEC_PROVIDER="dotenv://$PWD/.env.local"
secretspec set NETATMO_CLIENT_ID      # prompts; repeat for NETATMO_CLIENT_SECRET, NETATMO_REFRESH_TOKEN
secretspec run -- npm run probe       # one real request, prints a redacted summary
```

Fixtures take two steps. The probe saves the raw response (it contains personal data) to a
path outside the repository, then `capture:fixture` anonymises that file; the second step
needs no secrets:

```sh
secretspec run -- npm run probe -- --raw-out /path/outside/the/repo/raw.json   # add --history for getmeasure shapes
npm run capture:fixture -- /path/outside/the/repo/raw.json --name my-station
```

The probe writes a rotated refresh token back with a plain `secretspec set`, so the provider
must be the default one: export `SECRETSPEC_PROVIDER` as above, or save it once with
`secretspec config global init -p "dotenv://$PWD/.env.local" -P none` (a user-wide
setting). `-p <provider>` also works, but only as an option of the subcommand
(`secretspec set -p ... NAME`, `secretspec run -p ... -- cmd`).

1Password is the author's intended provider but its end-to-end use is **[unverified]**: `op`
was not installed when this was written, so only the secretspec side (alias stored,
provider selected, `op` is then asked for the secret) was seen, not a real vault. The
sequence is:

```sh
secretspec config global provider add onepassword 'onepassword://<vault>'
export SECRETSPEC_PROVIDER=onepassword
secretspec set NETATMO_CLIENT_ID      # and the other two
secretspec run -- npm run probe
```

Adding the alias alone is not enough; it does not select a provider. Inside `devenv shell`
the variables are not set automatically, always go through `secretspec run --`.

The probe and fixture scripts have not been run against the live service by the authors of
this repository snapshot. Because Netatmo rotates refresh tokens, a probe run consumes the
token it uses; the script writes the new one back through `secretspec set`.

Architecture and rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Project guide for
coding agents: [CLAUDE.md](CLAUDE.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): Conventional Commits, tests, and the privacy and
brand rules (no personal data, no real station data, anonymised fixtures).
Security reports: [SECURITY.md](SECURITY.md).

## Licence

MIT, see [LICENSE](LICENSE). Third-party material, trademark notice and artwork
provenance: [NOTICE](NOTICE).

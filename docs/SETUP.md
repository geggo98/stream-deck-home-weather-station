# Setting up the plugin with your own developer app

Status of this guide: written from Netatmo's public documentation (fetched 2026-11-13) and
from the design in [ARCHITECTURE.md](ARCHITECTURE.md). Nobody has run this procedure end to
end with the finished plugin. The developer portal needs a login. The maintainer saw its
scope selector in November 2026 (section 2); the token generator and a redirect-URI field
were not inspected. Steps that depend on portal behaviour are marked **[unverified]**.
The weather API itself was probed once with an existing refresh token (2026-11-13, the
maintainer's account with one station; results in [WEATHER-API.md](WEATHER-API.md)): station
data, history and the token refresh worked. That run says nothing about how a token is
obtained, so both routes in section 3 stay **[unverified]**.

## 1. Why your own app

Netatmo's API terms tie every API call to the key of an approved developer app and say the
key must be kept confidential and not shared with third parties. A plugin that shipped one
shared client id/secret would break that, and one rate-limit budget would be shared by
all users. So every user creates a free developer app for their own account. The plugin never
contains a client id or secret.

Netatmo's terms also allow only non-commercial use of the Weather API. This plugin is for
personal use.

## 2. Create the app

1. Sign in at <https://dev.netatmo.com> with the Netatmo account that owns the station and
   create an app (name and description are free text; pick something that does not look
   like an official Netatmo product).
2. Note the **client id** and **client secret**. They are credentials: do not paste them into
   issues, chats or the repository.
3. Tick exactly one scope: **`read_station`**. The portal's scope selector lists 24 entries
   (observed by the maintainer in November 2026): `read_station`, plus `read_`/`write_`/`access_`
   entries for other Netatmo products (thermostat, camera, doorbell, presence, smoke and CO
   detectors, shutters and so on). None of the others is needed:
   - `read_homecoach` belongs to the Healthy Home Coach, a different device the plugin does not
     support.
   - `write_*` scopes would let a leaked token change settings; `access_*` scopes need Netatmo
     approval. The plugin never asks for them.
   - If you ticked more scopes than `read_station`, generate the token again. A token keeps the
     scopes it was created with, and a broader one only enlarges the damage of a leak.
   `read_station` is also the default scope and needs no approval from Netatmo.

## 3. Get a token pair

Netatmo uses the OAuth2 authorization-code grant: an access token (valid 3 hours) and a
refresh token. The plugin keeps the access token fresh itself; it only needs one valid
refresh token to start.

Neither route below is confirmed against the live service (the probe mentioned at the top
started from an existing token and did not test either). Recommended order: try B first,
fall back to A.

Option B, browser sign-in (experimental, **[unverified]** against the live service): the
plugin listens on the fixed loopback port 53682, so the redirect URI is
`http://localhost:53682/callback`. Register exactly that URI in your Netatmo app's
settings (**[unverified]**: the portal's field names were not inspected, and Netatmo's
documentation does not say whether loopback redirects are accepted). Then enter client id and
client secret in the Property Inspector and press "Sign in with browser" (the Property
Inspector shows the same address). The plugin opens your browser, listens on the
loopback address for one callback (at most three minutes) and exchanges the code. The secret
field is cleared after the press; enter it again if you press a second time.

Option A, paste a token pair **[unverified]**: the developer portal is said to be able to
generate a token pair for your own app with scope `read_station`. Community projects
describe it; Netatmo's current documentation does not mention it and we could not inspect
the portal (it needs a login). If it exists, paste client id, client secret and
**refresh token** into the Property Inspector.

If neither works, please say so in an issue, quoting only the visible message and no secrets,
tokens, MAC addresses or station names. That is the most useful help to verify this guide.

When you save, the plugin performs one real token refresh and then one station query. The
new token pair is written to disk as soon as the refresh succeeded, before the station query:
if only the query fails, the tokens stay saved and the Property Inspector says "Saved, but ..."
with the reason (a token without `read_station` gets the advice to create it again with only
that scope). If the refresh fails, or the file cannot be written (disk full, no permission),
nothing is claimed as saved and the message says which of the two it was. The browser route
saves right after the code exchange in the same way.

## 4. Where the credentials are stored

A JSON file named `credentials.json` in a per-user directory called `home-weather-station`,
created with permission `0600` (owner read/write) and replaced atomically:

| OS | Location (`src/adapter/station/paths.ts`) |
|---|---|
| macOS | `~/Library/Application Support/home-weather-station/` |
| Windows | `%APPDATA%\home-weather-station\` |
| Linux / other | `$XDG_CONFIG_HOME/home-weather-station/` or `~/.config/home-weather-station/` |

Not stored in Stream Deck's settings: those are plain JSON in your profile (they may also travel with profile
exports or backups, **[unverified]**), and are dumped into log files at TRACE level
(per the SDK behaviour documented in ARCHITECTURE.md).
The file is **not encrypted**. Anyone who can read your user account's files can read it.
On Windows the `0600` mode has no effect (the profile directory's access control list
applies instead; **[unverified]**, nobody has run the plugin on Windows). See
[../SECURITY.md](../SECURITY.md).

To remove everything: press the clear-credentials button in the Property Inspector (it asks for
confirmation: press it twice; the status then shows "Removing..." until the file is gone, or the
reason and the file's location if it could not be removed), or delete the directory. **Clear does
not revoke anything at Netatmo**: the tokens stay valid there until they expire or you revoke or
delete the app in the developer portal.

## 5. The rotation trap

Netatmo **rotates** the refresh token on every refresh: the response carries a new refresh
token and the previous one stops working at once. Consequences:

- The plugin writes the new pair to disk before it hands out the new access token. If that
  write fails (two attempts), it logs an error, carries on with the new pair in memory only
  and shows the warning "The renewed sign-in could not be saved to disk. Data is current,
  but after a restart you will have to sign in again." in the account status of the
  Property Inspector and as a warning marker on the keys (the keys keep their normal face and
  are not dimmed). It retries the write on every poll
  and the warning disappears once a write succeeds. Until then, a restart of the plugin or
  the machine loses the pair and you must authorise again. If the plugin or the
  machine dies in the middle of the write, you must authorise again as well.
- **Never use the same app or refresh token in two programs** (this plugin and a home-automation
  integration, a second computer, a script). Whichever refreshes second invalidates the
  other's token and the plugin shows `Sign in` after a while. Create one Netatmo app per
  client.
- Copying `credentials.json` to a second computer has the same effect. Set up each computer
  separately with its own app.
- If you test with the probe script (see the README), it consumes the refresh token you give
  it and stores the replacement; if it cannot store it, it exits with an error saying so, because
  the old token is then invalid. Do not run it with the token the plugin uses.
- Auth errors stop polling on purpose: retrying a rejected token only burns the rate limit.

## 6. Rate limits and polling

Netatmo's documented limits are 50 requests per 10 seconds and 500 per hour per user
(the page states them for the Smart Home API; applying them to the Weather API is an
inference). The plugin polls once for all keys, every 5 minutes by default, never faster than
once per minute. Netatmo stations update about every 10 minutes, so faster polling only
repeats the same values. History keys (24 h curve) share this budget: they fetch only while visible, cache each
curve for 10 minutes and make at most one real request per curve per 30 seconds (a failed
request is not retried sooner). The plugin
stays far below 500 per hour (the numbers are UNVERIFIED for the weather API). The plugin never registers webhooks: an app has only one webhook
URL and registering one would replace another client's.

## 7. Troubleshooting setup

| Symptom | Likely cause |
|---|---|
| Save fails with an authorisation error | Wrong client id/secret pair, token generated for another app, token without `read_station`, or token already rotated by another client. |
| Save works, keys show `No signal` | The module itself is not reporting; check Netatmo's app. |
| Browser sign-in never completes | Redirect URI not registered exactly as shown, port in use, or Netatmo refuses loopback redirects **[unverified]**. Use option A. |
| Works for a day, then `Sign in` | Another client refreshed with the same token (section 5), or the plugin was killed during a refresh. |

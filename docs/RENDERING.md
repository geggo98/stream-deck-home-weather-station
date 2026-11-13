# Artwork and rendering

The plugin's artwork is AI-generated original work, made with the Codex CLI. Who has
looked at it: an AI agent during generation and the integrating AI assistant afterwards,
both reading the images. The maintainer has not looked at them yet and should do so before
a release (nobody has checked them by eye for a lookalike of a third-party logo). No Netatmo, Elgato, Stream Deck or other third-party artwork, logo, product
photo or colour identity was used as input or imitated. The motifs (sun, cloud, drop,
thermometer, wind lines, a round sensor) are generic. This is an unofficial project; see
the README for the non-affiliation notice.

## What is where

| File | Origin |
|---|---|
| `de.schwetschke.sd.home-weather-station.sdPlugin/imgs/plugin/plugin-icon.png` (256x256), `plugin-icon@2x.png` (512x512) | Codex image tool (job `plugin-icon-c`), downscaled with ImageMagick, opaque |
| `.../imgs/plugin/category-icon.png` (28x28), `category-icon@2x.png` (56x56) | NOT Codex: the Lucide `cloud-sun` glyph (ISC licence, from the `lucide-static` dev dependency), recoloured to `#FFFFFF`, rasterised with ImageMagick, white on transparent |
| `assets/final/plugin-icon-source.png` | 1024x1024 source of the plugin icon (committed; maintainer review pending) |
| `assets/final/previews/tile-*.svg` + `.png` (144x144) | Codex SVG, illustrative key tiles for the documentation; placeholder values only, not a picture of any device |
| `assets/rendered/` | raw Codex output and per-job `*.meta.json` (git-ignored, never committed) |

## Re-running

Requirements: `codex` on the PATH and logged in (`codex login status` prints "Logged in
using ChatGPT" or similar), ImageMagick 7 (`magick`), `python3` (stdlib only; the scripts
also carry a PEP 723 header and `.lock` file for `uv`).

```sh
npm run render                                  # scripts/render-jobs.json -> assets/rendered/
python3 -I scripts/render-with-codex.py --status scripts/render-jobs.json assets/rendered
# review assets/rendered/* (checklist below), then:
python3 -I scripts/finalize-assets.py --icon assets/rendered/plugin-icon-c.png --previews
python3 -I scripts/finalize-assets.py --check   # sizes, opacity, white-on-transparent
```

Options of the render script: `--only NAME` (repeatable), `--force` (re-render valid
outputs), `--timeout SECONDS` (per job, default 600), `--codex-bin` (tests pass a fake),
`--auth-file` (default `~/.codex/auth.json`).

The run is resumable and abortable (the rules of the maintainer's long-running-script
practice): an output that validates is SKIPped, so after Ctrl-C, a quota stop or a crash
just start it again. The summary line separates the four outcomes, for example
`3 ok, 4 skip, 0 error, 0 cleanup, 0 left - nothing left to do`. Exit codes: 0 done or
nothing to do, 1 at least one error, 2 usage or configuration error, 75 another run holds
the lock (`.run.lock`, an `flock`; `.run.status` shows pid and start time, for display
only), 128+signal aborted. SIGINT/SIGTERM are forwarded to the Codex child's whole process
group, so an abort takes seconds. Progress lines (`n/N`, rate, ETA, elapsed) go to stderr,
one per finished job plus a heartbeat every 15 s; the rate counts only jobs really
rendered in this run.

## Privacy isolation, and why

Measured on 2026-11-13: `codex exec --ignore-user-config --ignore-rules` still loads the
user's global `~/.codex/AGENTS.md`. Asked to quote its instruction files, Codex returned
the maintainer's private global rules. Those would be sent to the model provider with
every call. Therefore every job runs with

* a throwaway `CODEX_HOME` that contains only a symlink to the login file (no
  `AGENTS.md`, config, memories, skills, history), and
* an empty throwaway working directory (no repository files, no `.env`, no manifest),

both deleted afterwards (the symlink is removed, never followed). Probe with the isolated
home: no instruction files visible; input tokens per call dropped (about 46k against
55-58k in the research run, about 31k for the SVG jobs here). The script never reads the
login file. One caveat: if Codex refreshes its login it may replace the symlink with a
regular file inside the throwaway home; the script then copies that file back to the
original (mode 0600) so a rotated refresh token is not lost. This path is covered by a
test with a dummy file; against the real Codex it is unverified (it did not trigger in the
run described below).

Prompts are static art direction. The script refuses, before anything is sent: secrets
and token names, e-mail addresses, MAC and IPv4 addresses, brand and manufacturer names,
and any request for a logo, trademark, brand look or imitation (only the negation "no
logos" passes, which the script appends itself). The guard runs over the whole jobs file
at load time and fails the run with exit 2.

## Trademark rules for prompts

* Never name the weather-service brand, the hardware vendor or the Stream Deck product in
  a prompt; the guard enforces it. Describe motifs ("round sensor", "sun", "cloud").
* Never ask for a logo, wordmark, product photo, "in the style of" or "looks like".
* No lettering in icons (the icon prompts and the script say so); the tiles contain only
  placeholder numbers and units.
* Naming and the non-affiliation notice belong in the README and manifest, not in art.
* "Netatmo" never appears in file names, icons or the manifest.

## Output validation

SVG: at most 200 kB, well-formed XML, no DOCTYPE/ENTITY, root `svg` in the SVG namespace
with exact `width`, `height` and `viewBox`, none of `<script>`, `<image>`,
`<foreignObject>`, `<style>`, animation elements, event attributes, `@import`, external
`href` or `url()`. PNG: signature, every chunk CRC, IHDR, IDAT and IEND present (so a
truncated file fails), exact size (for icons `min_square`: any square at least that large,
reduced afterwards). Failed validation is an ERROR and nothing is published.

## Review checklist for generated images

Open every candidate (do not trust the validator for taste or legal questions):

1. No lettering, digits, pseudo-text or watermark anywhere (zoom into corners and
   surfaces). Tiles: only the expected placeholder strings.
2. No logo, emblem or mark that resembles a real company's; no recognisable product
   silhouette. Check against the manufacturer's look from memory of its public product
   photos: do not copy form, colour identity or proportions.
3. Not a lookalike of something else by accident (candidate `plugin-icon-b` reads as a
   microphone).
4. Opaque, full-bleed background for the plugin icon (candidate `plugin-icon-a` came
   with light corners from a baked-in rounded square, which would show as white corners).
5. Artefacts: broken geometry, smeared edges, uneven rays, stray pixels.
6. Legibility at 256 px and 72 px; calm blue/teal palette, no gradients that band.
7. Tiles: text fits, contrast against the dark tile, nothing clipped.
8. `python3 -I scripts/finalize-assets.py --check` passes.

Review result of this run (2026-11-13): `plugin-icon-c` (two round modules: sun on blue,
cloud with a drop on teal, light-blue full-bleed background) passed and was chosen; `a`
rejected for the baked-in rounded corners, `b` for resembling a microphone. All four
tiles passed (no stray text, correct placeholder strings, units fit).

## Provenance

* Tool: `codex-cli 0.167.0`, image generation through the built-in `image_gen` tool of
  the bundled imagegen skill, ChatGPT-plan login (no API key).
* Date: 2026-11-13.
* Isolation as described above; `--ephemeral --skip-git-repo-check --ignore-user-config
  --ignore-rules --json -s workspace-write`.
* Raw per-job metadata (prompt, duration, token usage) is written next to the raw output
  in `assets/rendered/<name>.meta.json` (git-ignored).

Measured on that run (7 jobs, sequential, wall time about 173 s in total):

| Job | Time | Input tokens (cached) | Output tokens |
|---|---|---|---|
| plugin-icon-a | 39.7 s | 94,730 (79,616) | 443 |
| plugin-icon-b | 41.8 s | 82,619 | 461 |
| plugin-icon-c | 37.1 s | 93,431 | 463 |
| tile-temperature | 15.2 s | 30,821 | 360 |
| tile-humidity | 11.9 s | 30,720 | 264 |
| tile-co2 | 13.5 s | 30,795 | 311 |
| tile-wind | 13.0 s | 30,794 (27,648) | 304 |

Plan and quota: the CLI reports token counts per turn but nothing about plan limits; no
rate-limit or quota message appeared in this run. Whether image generation draws down the
ChatGPT plan allowance faster than text is unobserved.

### Exact prompts

The script appends format rules to each prompt. For SVG: write to `./result.svg`, exact
root element with `width`, `height`, `viewBox`, basic shapes/paths/gradients and `<text>`
with a generic font family, presentation attributes instead of `<style>`, no script,
image, foreignObject, animation, external fonts or links, "No logos or trademarks."
For PNG: "Use your image generation tool. Copy the final PNG to ./result.png. Opaque
background, no text, no logos or trademarks."

The job prompts (`scripts/render-jobs.json`, verbatim):

**`plugin-icon-a`** (png, 1024x1024)

> One square flat app-icon concept for a home weather station plugin. Motif: a small round sensor puck seen from the front, centred, with a simple sun peeking out behind a soft cloud drawn on its face. Calm blue and teal palette with a soft vertical gradient background, generous padding, rounded-square composition, clean vector look, no gloss, no photographic detail. Keep the design generic and original; do not copy any real product.

**`plugin-icon-b`** (png, 1024x1024)

> One square flat app-icon concept for a home weather station plugin. Motif: a tall rounded cylinder sensor tower in profile, standing on a small base, with a sun above-left and a small cloud above-right. Deep teal background with lighter teal and white accents, minimal flat vector style, generous padding. Keep the design generic and original; do not copy any real product.

**`plugin-icon-c`** (png, 1024x1024)

> One square flat app-icon concept for a home weather station plugin. Motif: two overlapping circles, a larger one holding a sun with short rays and a smaller one holding a raindrop and a cloud, like two small sensor modules side by side. Calm blue and teal palette, soft gradient, flat vector style, generous padding. Keep the design generic and original; do not copy any real product.

**`tile-temperature`** (svg, 144x144)

> Create an illustrative 144x144 key tile for a weather display. Dark slate rounded square (corner radius 18, fills the whole canvas). Top-centre: a simple thermometer glyph in warm orange. Below it the large placeholder number "21.4" in white bold sans-serif, and under that a small light-grey "°C". Generic, flat, no decoration. The text must be exactly these strings and nothing else.

**`tile-humidity`** (svg, 144x144)

> Create an illustrative 144x144 key tile for a weather display. Dark slate rounded square (corner radius 18, fills the whole canvas). Top-centre: a simple water-drop glyph in light blue. Below it the large placeholder number "56" in white bold sans-serif, and under that a small light-grey "%". Generic, flat, no decoration. The text must be exactly these strings and nothing else.

**`tile-co2`** (svg, 144x144)

> Create an illustrative 144x144 key tile for a weather display. Dark slate rounded square (corner radius 18, fills the whole canvas). Top-centre: a simple glyph of three wavy air lines in soft green. Below it the large placeholder number "612" in white bold sans-serif, and under that a small light-grey "ppm". Generic, flat, no decoration. The text must be exactly these strings and nothing else.

**`tile-wind`** (svg, 144x144)

> Create an illustrative 144x144 key tile for a weather display. Dark slate rounded square (corner radius 18, fills the whole canvas). Top-centre: a simple wind glyph (two curled streamlines) in light teal. Below it the large placeholder number "3.2" in white bold sans-serif, and under that a small light-grey "m/s". Generic, flat, no decoration. The text must be exactly these strings and nothing else.

## Known limits

* The built-in image tool returns a fixed size (1254x1254 in all runs) and offers no exact
  size control; hence `min_square` and the ImageMagick downscale. Not guaranteed to stay
  so with other Codex versions.
* Transparent backgrounds were not tested; the plugin icon is intentionally opaque.
* Results vary run to run; a re-run will not reproduce the same pictures. The committed
  `assets/final/plugin-icon-source.png` and `previews/` are the artefacts of record, the
  prompts are the recipe.
* Whether the Stream Deck app renders `<text>` with the generic `sans-serif` family the
  same way as the PNG exports (ImageMagick/librsvg) is unverified. The previews are
  documentation illustrations, not shipped key images.
* Codex flags and behaviour can change (a newer version was announced by `codex doctor`
  during research); the sandbox network policy of `-s workspace-write` was not verified.
* No hardware was involved; nothing here was seen on a real Stream Deck.
* The icon candidates and previews were looked at only by AI agents (the generating run and
  the integrating assistant) reading the images; the maintainer has not checked them yet.
  A human pass before the first release is required, not just advised.

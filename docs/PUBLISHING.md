# Publishing and releasing

How this plugin is versioned and distributed. Distribution is **GitHub Releases only**.
The single build artifact is `de.schwetschke.sd.home-weather-station.streamDeckPlugin`,
produced by `streamdeck pack` (`npm run pack`). That the Stream Deck CLI does not apply DRM and
that the file therefore works for sideloading is an author claim **[unverified]**. Installing a
self-built pack (double-click in the Stream Deck app) was not tried, neither on the app nor on hardware.

## Not on the Marketplace, on purpose

- The brand situation ([BRANDING.md](BRANDING.md)): Netatmo's API terms require written
  validation of any use of its brand before distribution, and none exists. A Marketplace
  listing is a more prominent, more "official-looking" distribution than a GitHub download
  and would add Elgato's own naming and review rules on top.
- The Weather API may only be used non-commercially; a Marketplace listing invites
  commercial-looking use and support expectations the project cannot meet.
- Each user needs their own developer app; this is acceptable for people who find the project
  on GitHub, but is the kind of setup friction a store review may reject **[unverified]**.

**What would have to be re-checked if this ever changes:**

1. Written validation from Netatmo for the exact name, description and artwork used.
2. Elgato's current plugin and product guidelines (naming, "Stream Deck" and "plugin" in names,
   icon sizes, description rules) and the Maker Console submission requirements. Nothing about
   the Marketplace flow was verified for this project.
3. The manifest `URL` must resolve (the validator warns while the repository is private).
4. Whether the unofficial/non-affiliation wording still fits next to the store listing.
5. The non-commercial limit: still no ads, paid tier or sponsor links.

## Cutting a release (automated, PR-gated)

Releases are driven by [release-please](https://github.com/googleapis/release-please) from the
[Conventional Commits](../CONTRIBUTING.md) on `main`. Nobody edits versions or the changelog by
hand.

1. Merge feature/fix PRs to `main` (`feat:`, `fix:`, `perf:`, ...).
2. The **Release** workflow (`.github/workflows/release.yml`) opens or updates a
   `chore(main): release X.Y.Z` PR that maintains `CHANGELOG.md` and bumps `package.json` and
   `package-lock.json`. The manifest's 4-part `Version` is derived from `package.json` at build
   time by `scripts/sync-manifest-version.ts` (the Stream Deck CLI rejects 3-part versions),
   so the committed manifest may lag one release; the packed file is always correct.
3. Review and merge that PR when you want to ship.
4. On merge release-please creates the `vX.Y.Z` tag and the GitHub Release; the `publish` job
   builds, validates, packs and attaches `*.streamDeckPlugin` to it.

Pre-1.0 (`0.y.z`): `fix:`/`perf:` bump patch, `feat:` bumps minor, `feat!:` also minor.

### One-time repository setup

- **Settings, Actions, General, Workflow permissions**: enable *Allow GitHub Actions to create
  and approve pull requests*. Without it release-please cannot open its release PR.
- Pull requests created with the default `GITHUB_TOKEN` do not trigger other workflows (GitHub's
  documented behaviour), so CI does not run on the release PR by itself; close and reopen it, or
  push an empty commit to it, before merging. A personal access token or GitHub App for
  release-please would avoid that; not set up here.
- `.release-please-manifest.json` seeds version `0.1.0`. With no earlier tag, the first release PR
  summarises the whole history; trim `CHANGELOG.md` in the PR if you want a tidier entry.
- Release notes should repeat the first two sentences of the README notice
  ([BRANDING.md](BRANDING.md) checklist).

### Preview without shipping

```sh
npx release-please release-pr --dry-run \
  --repo-url=geggo98/stream-deck-home-weather-station \
  --config-file=release-please-config.json \
  --manifest-file=.release-please-manifest.json \
  --token="$(gh auth token)"
```

release-please reads config and manifest from the remote target branch, so this works once the
files are on `main`.

## Installing from a release (sideload)

1. Download the `.streamDeckPlugin` file from the release page.
2. Double-click it; the Stream Deck app installs it.
3. Developers can instead run `npm run build` and link the `.sdPlugin` folder with the Stream
   Deck CLI.

Until the repository is public, `npm run validate` prints one warning, `URL should return
success (received 404)`, for the manifest `URL`. That is expected and not a failure; it must
be gone before the first release.

The packed bundle also carries the licence texts: the build writes `LICENSE`, `NOTICE` and
`THIRD-PARTY-NOTICES.txt` into the `.sdPlugin` folder (so that the minified `bin/plugin.js`
and the vendored libraries ship with their licences). These three files are generated, listed
in `.gitignore`, and never committed. Check that they are in the packed file before a release.

Before attaching or announcing anything: confirm `Nodejs.Debug` is absent from the packed
manifest (`npm run verify:manifest` runs inside `npm run pack`), and that the repository has no
files listed as untracked secrets.

## OpenDeck

OpenDeck is an open-source application that can run plugins written for the original Stream Deck
SDK. Whether this plugin loads there is **[unverified]**: nobody has tried it. A sibling project
reported that OpenDeck starts plugins with the system `node`, so Node.js 24 would have to be
installed **[unverified]**. Do not add `linux` to the manifest `OS` list on the strength of that.

## Checklist before the first public release

- [ ] Repository public, so the manifest `URL` resolves and `npm run validate` is clean.
- [ ] Setting "Allow GitHub Actions to create and approve pull requests" enabled.
- [ ] `docs/BRANDING.md` checklist green; owner has decided about the validation e-mail.
- [ ] Credentials flow tried once against a real account and hardware (nobody has done this yet),
      including the redirect URI `http://localhost:53682/callback` registered in the Netatmo app.
- [ ] The maintainer has looked at the artwork (`assets/final/`, the plugin icon); so far only
      AI agents have ([RENDERING.md](RENDERING.md)).
- [ ] Repository topics set: `streamdeck`, `stream-deck-plugin`, `weather-station`, `netatmo`.

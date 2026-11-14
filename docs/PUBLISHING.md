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
3. The manifest `URL` must resolve (it does while the repository is public).
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
4. On merge release-please creates the `vX.Y.Z` tag and the GitHub Release. Then two jobs
   run. `build` checks out the tag with a read-only token (no write permission at all), runs
   `npm ci --ignore-scripts`, typecheck, build, tests, validate and pack, and hands the
   `.streamDeckPlugin` over as a workflow artifact. `upload` has the write token, but no
   checkout and no npm: it downloads that artifact, attests its build provenance with
   `actions/attest-build-provenance` (permissions `id-token` and `attestations` write only in
   this job) and attaches the file with `gh release upload`. A compromised install script can
   therefore not reach the token that writes to the release. The new actions
   (`actions/download-artifact`, `actions/attest-build-provenance` and the action it calls
   itself, `actions/attest`) must be on the allow-list: run `npm run github:settings -- --check`,
   and `--apply` after review. The first run of this job (release v0.1.1) failed exactly on the
   missing nested pin; after the fix and a re-run of the failed job the asset was attached and
   `gh attestation verify` accepted it.

   **If `upload` (or `build`) fails after the tag and release exist**, the release stays
   without an asset until the job is repeated. Open the failed run on the Actions page and use
   "Re-run failed jobs", or run `gh run rerun <run-id> --failed`. Do this within one day: the
   hand-over artifact has `retention-days: 1`, and a re-run of `upload` needs it (a re-run of
   `build` should make a new one, UNVERIFIED). Re-running the whole workflow or merging again does not help:
   release-please sees the release as done and does not report it as created again. If the
   cause was a missing allow-list entry, as in v0.1.1, fix it first (`npm run github:settings --
   --check`, then `--apply` after review): an action pinned in a workflow, or called by a
   pinned action, must be on the allow-list by its exact SHA; Dependabot bumps of
   `attest-build-provenance` can change the nested pin without any CI job noticing, because
   `ci.yml` never runs the attest step.

Pre-1.0 (`0.y.z`): `fix:`/`perf:` bump patch, `feat:` bumps minor, `feat!:` also minor.

### Repository settings (as code)

The settings are kept in `scripts/github-settings.py` and were applied with
`npm run github:settings -- --apply` (admin rights needed; `--check` reports drift read-only,
`--print-plan` prints the plan without any network call). What it enforces:

- **Actions allow-list = the pins.** Only the actions pinned in `.github/workflows/*.yml` may
  run (plus the pinned actions that composite actions call themselves, `TRANSITIVE_PINS` in the
  script: `attest-build-provenance` calls `actions/attest`, which the first release run revealed;
  each entry is keyed by the wrapper's exact pin, so a bump of the wrapper makes
  `tests/github-settings.test.ts` fail until the nested pin is re-resolved),
  each by its exact commit SHA; nothing GitHub-owned or "verified" is allowed by default,
  and *Require actions to be pinned to a full-length commit SHA* is on. The allow-list is
  generated from the workflows, so it cannot drift from them (`tests/github-settings.test.ts`).
  **Approval flow for an action update** (Dependabot or by hand): review the diff of the new
  SHA, check out that branch, run `npm run github:settings -- --apply` (adds the new pin and
  keeps the old ones so `main` keeps working), merge, then `-- --apply --prune` to drop the old pin.
  Until then the update's CI run is refused by GitHub: that refusal is the control.
- **Workflow token read-only by default**; each job asks for more. *Allow GitHub Actions to
  create and approve pull requests* is on because release-please needs it (a trade-off: a
  compromised workflow could then approve PRs; the allow-list and pinning limit what can run).
- **Outside contributors**: workflow runs need approval every time.
- **Secret scanning with push protection**, Dependabot alerts and security updates, private
  vulnerability reporting, CodeQL default setup for JavaScript/TypeScript (GitHub runs it itself,
  outside the allow-list; the language list showed empty right after enabling: **[unverified]**
  that it picks up the code, check *Security, Code scanning* after the first run).
- **Rulesets** without bypass actors: `main` cannot be deleted or force-pushed; release tags `v*`
  cannot be moved, deleted or re-created. Direct pushes to `main` are still allowed (single
  maintainer); a required-PR rule is the next step if more people get write access.
- **Squash merges only**, PR title as commit message (Conventional Commits drive
  release-please), branches deleted after merge, no wiki, projects or discussions.

Checks in CI: `pinact run --check` (every `uses:` pinned), `zizmor` (workflow injection,
credential persistence, permissions, known-vulnerable actions), `osv-scanner` on
`package-lock.json` (gates the build; time-limited exceptions in `osv-scanner.toml`, see
SECURITY.md), dependency review on pull requests (new dependencies with high advisories or
unlisted licences fail; the licence allow-list in `ci.yml` is **[unverified]** against the real
tree and may need an entry), and `.github/workflows/security.yml`, which repeats the
osv-scanner and zizmor checks every Monday because advisories appear without commits.

### One-time repository setup

- **Workflow permissions** (done by the script, listed for completeness): *Allow GitHub Actions
  to create and approve pull requests*. Without it release-please cannot open its release PR.
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
  --repo-url=<owner>/<repo> \
  --config-file=release-please-config.json \
  --manifest-file=.release-please-manifest.json \
  --token="$(gh auth token)"
```

release-please reads config and manifest from the remote target branch, so this works once the
files are on `main`.

## Installing from a release (sideload)

1. Download the `.streamDeckPlugin` file from the release page.
2. Double-click it; the Stream Deck app is expected to install it **[unverified]**: nobody has
   tried it.
3. Developers can instead run `npm run build` and link the `.sdPlugin` folder with the Stream
   Deck CLI.

`npm run validate` is clean now that the repository is public (an earlier warning about the
manifest `URL` returning 404 is gone).

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

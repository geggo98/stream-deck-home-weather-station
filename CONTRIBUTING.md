# Contributing

Thanks for helping. This is an unofficial, non-commercial hobby plugin; please read the
privacy and brand rules below before you open a pull request, they matter more here than in
most projects.

## Development environment

Tooling comes from [devenv](https://devenv.sh) (Node.js 24, tsx, pinact, osv-scanner, git hooks).

```sh
devenv shell        # or: direnv allow
npm ci
```

Git hooks (installed by devenv) check the commit message (Conventional Commits), refuse a manifest
with a `Nodejs.Debug` key, refuse raw control bytes and invisible or bidirectional Unicode characters in sources (write them as `\u` escapes) and run `gitleaks` on staged files with `.gitleaks.toml`. That file allows only the fake sentinel
secrets of two named tests; a test that needs another fake secret should build it at run time or
use the same `CS-/RT-/AT-distinctive-` sentinel shape, not widen the allowlist.
`osv-scanner` runs before push.

## Before you open a pull request

```sh
npm run typecheck
npm test            # node --test tests/*.test.ts
npm run build && npm run validate && npm run pack   # when manifest, icons or build changed
```

Tests run with Node's native type stripping: no `enum`, no constructor parameter properties, no
`namespace`; relative imports carry the `.ts` extension; no raw control bytes (write unicode escapes).
Style: TypeScript, tabs, double quotes. The adapter layer (`src/adapter/**`) never imports
`@elgato/streamdeck`; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Conventional Commits

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org).
release-please derives versions and the changelog from them.

| Type | Use for | Version effect (0.y.z) |
|---|---|---|
| `feat` | user-visible feature | minor |
| `fix` | bug fix | patch |
| `perf` | performance | patch |
| `refactor`, `docs`, `build`, `ci`, `revert` | listed in the changelog | none |
| `chore`, `style`, `test` | hidden from the changelog | none |

Breaking change: `feat!:` or a `BREAKING CHANGE:` footer. Useful scopes: `auth`, `adapter`,
`actions`, `render`, `pi`, `manifest`, `docs`, `deps`, `ci`, `devenv`.

## Privacy rules (non-negotiable)

Never commit, in code, tests, fixtures, docs, comments, screenshots, issue text or commit messages:

- tokens, client ids or secrets, passwords, anything from a real `credentials.json`;
- real MAC addresses (Netatmo station and module ids are MAC addresses), account or user ids;
- real coordinates, addresses, altitude of a real station, real station or module names;
- e-mail addresses or names of people other than the maintainer entry in `package.json`;
- internal hostnames, ticket numbers, pull request numbers or repository names of other people or
  employers; IP addresses outside the documentation ranges.

Identifiers do not announce themselves: an id is a bare string without any telling word next to it.
`tests/repo-hygiene.test.ts` therefore scans for identifier *formats* (MAC, e-mail, IPv4, UUID,
long token-like strings, ticket-like patterns, repository slugs, coordinate pairs), but it is a
safety net, not a review. If it fires, fix the data; do not extend its allowlist to make it quiet
unless the match is demonstrably not an identifier, and then say why in the allowlist comment.

### Anonymising a fixture

Real API responses (for example from `npm run capture:fixture`) must be rewritten before they enter
the repository. Replace:

| Real | Fictional |
|---|---|
| module / station ids (MAC) | `00:00:5e:00:53:xx` (documentation range, vary the last byte) |
| user id, `_id` fields, tokens | fixed placeholders such as `user-0001`, `<redacted>` |
| station and module names | `Test Station`, `Indoor`, `Outdoor`, `Wind`, `Rain` |
| `place` (location, altitude, timezone, country, city) | fictional or removed values; never real coordinates |
| IP addresses | `192.0.2.x`, `198.51.100.x`, `203.0.113.x` |
| e-mail addresses | removed |

Keep the structure and the numeric measurement values' shape (they are not identifying on their own,
but round or shift them if the combination could identify a place or a time). Write a test that
parses the fixture, and run `npm test` so the hygiene scan sees it. Pasted example output is the most
common way identifiers enter a repository: replace everything on the line, not only the
conspicuous parts.

## Brand rules

See [docs/BRANDING.md](docs/BRANDING.md). In short: "Netatmo" only as a compatibility statement in
running text, never in manifest `Name`, `Category`, `Author`, UUIDs, file or folder names, icons or
package names; no Netatmo, Elgato or Corsair logos, product photos or colours as identity;
"Stream Deck" as two words, "plugin" without hyphen; nothing commercial (no ads, paid features,
sponsor or donation links). `tests/branding.test.ts` covers the mechanical part.

## Logging rules

Never log tokens, secrets, Authorization headers, URLs with query strings, module ids at INFO or raw
API bodies. API text is untrusted: do not put it into SVG markup; truncate it for logs.

## Forking

If you publish a fork, change the plugin id (`de.schwetschke.sd.home-weather-station`), the
`.sdPlugin` folder name and the author; otherwise it collides with the original plugin in users'
Stream Deck installs. Keep the non-affiliation notice and do not use the original maintainer's name
as if the fork were the original.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence of this project.

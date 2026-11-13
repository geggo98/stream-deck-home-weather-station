## What and why

<!-- One or two sentences. Use a Conventional Commit title (feat:, fix:, docs:, ...). -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass locally (`devenv shell -- npm test`).
- [ ] If the manifest, icons or the build changed: `npm run build`, `npm run validate` and `npm run pack` pass.

### Privacy (see CONTRIBUTING.md)

- [ ] No tokens, client ids or secrets, no real MAC addresses, coordinates, addresses, station or module names, e-mail addresses, account ids, ticket or PR numbers, hostnames or other people's repository names were added, including in test fixtures, docs, comments, screenshots and commit messages.
- [ ] New fixtures are fictional: MAC addresses from the documentation range, IPs from RFC 5737, names like "Test Station".
- [ ] No logging of tokens, Authorization headers, URLs with query strings or raw API bodies.

### Brand (see docs/BRANDING.md)

- [ ] No Netatmo, Elgato, Corsair or Stream Deck logos, product photos or brand colours as identity.
- [ ] "Netatmo" appears only as a compatibility statement in running text; not in the manifest `Name`, `Category`, `Author`, any UUID, file or folder names, icons or package names.
- [ ] Nothing commercial: no ads, paid tiers, sponsor or donation links.

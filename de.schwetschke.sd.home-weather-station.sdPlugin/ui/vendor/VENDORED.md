# Vendored third-party code in the Property Inspector

The Property Inspector pages load no code from the network. The one third-party
script they use is checked in here, so what runs is exactly what was reviewed.

| File | Source | Version | Size | SHA-256 | Licence |
|---|---|---|---|---|---|
| `sdpi-components.js` | `https://sdpi-components.dev/releases/v4/sdpi-components.js` (the URL the official "Get Started" page names) | v4.0.1 (from the file's own licence header) | 55823 bytes | `f6c0dfd2ed68e18084b9952842b86e3850cf837d674704700c2a0718e0a24f6b` | sdpi-components: MIT. It bundles Lit: BSD-3-Clause (header: "Lit, Copyright 2019 Google LLC, SPDX-License-Identifier: BSD-3-Clause"). |

## Provenance check

Two copies were compared on 2026-11-13:

1. the file of a sibling project of the maintainer (also v4.0.1), and
2. a fresh download of the official URL above into an empty directory, read as
   text only (never executed).

Both have the same size and the same SHA-256, so they are byte-identical, and
that file is the one used here. A static text scan of the file found no `fetch`,
`XMLHttpRequest`, `Worker`, `importScripts`, `sendBeacon`, `eval` or
`new Function`; the only URLs in it are the SVG namespace
(`http://www.w3.org/2000/svg`) and the two attribution links in the licence
header (`lit.dev`, `sdpi-components.dev`). A text scan is not a proof of
absence (the file is minified), which is why the Property Inspector also carries
a Content Security Policy that blocks everything but the local Stream Deck
WebSocket.

"v4" is a moving URL: the same address may serve a later 4.x release some day,
so a different hash on a later download is expected and not an alarm by itself.

## Update procedure

1. Download the new file into a new, empty directory outside the repository.
2. `diff` it against `sdpi-components.js` here; read the change, do not just run it.
3. Search it for `fetch`, `XMLHttpRequest`, `Worker`, `importScripts`,
   `sendBeacon`, `eval`, `new Function` and for hosts other than the ones above.
   Any hit needs an explanation before the file goes in.
4. Replace the file and update the table above (version, size, SHA-256, date).
5. Open one Property Inspector of every kind (`measurement.html`, `dial.html`) in
   Stream Deck: dropdowns fill, checkboxes persist, the account block works.
6. Run `node --test tests/pi-*.test.ts`.

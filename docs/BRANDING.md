# Branding and naming: decision record

Status: decided 2026-11-13, open items at the end. This document is a project decision
record, **not legal advice**. Sources were read on 2026-11-13; anything not confirmed from a
primary text is marked **[unverified]**.

## Decision

- Product name: **Home Weather Station**. Plugin id `de.schwetschke.sd.home-weather-station`.
  Repository `stream-deck-home-weather-station`.
- Two tiers, enforced by `tests/branding.test.ts`:
  1. **Never in any identity**: **Netatmo**, **Legrand**, **Elgato**, **Corsair**. Not in the
     manifest `Name`, `Category`, `Author`, any UUID, file or folder names, image names, the
     repository name or the npm package name.
  2. **"Stream Deck" is allowed descriptively** in the repository name and the (private) npm
     package name (`stream-deck-home-weather-station`), the same nominative use as in the
     manifest `Description` ("works with Stream Deck"). It is not allowed in the product
     name, the manifest `Name`, `Category`, `Author` or any UUID, and the word **plugin**
     is not allowed there either. File names that the SDK mandates or that merely say what
     a file is (`src/plugin.ts`, `bin/plugin.js`, `imgs/plugin/`, the packed
     `*.streamDeckPlugin`) are fine: they are not a name anyone sees as the product's.
- "Netatmo" appears only as a factual compatibility statement in running text (README,
  manifest `Description`, docs), always next to the non-affiliation notice. "Stream Deck" appears
  in the repository and package name, the README and the docs as a descriptive reference,
  written as two words.
- No Netatmo, Elgato or Corsair logo, product photo, brand colour used as identity, or "works
  with" badge. Artwork is original (see [RENDERING.md](RENDERING.md), [NOTICE](../NOTICE)).
- Strictly non-commercial: no ads, paid tier, paywall, sponsor or donation links.
- Distribution on GitHub Releases only, not on the Elgato Marketplace
  ([PUBLISHING.md](PUBLISHING.md)).

## Why this name

1. **Netatmo's own terms are stricter than the usual "nominative use" baseline.** The API
   terms of use (<https://dev.netatmo.com/legal>, section PROPERTY) permit the word in an
   application's name and content "only in order to indicate the source of the data, the
   affiliation between your application and our services or the compatibility of your
   application with a Netatmo account", forbid using it "in a deceptive manner, that would
   mislead the user to believe that your application would be an official production of
   Netatmo", and then add:

   > "Any use of the brand « Netatmo » shall be validated in writing by Netatmo before any
   > distribution of your products and/or services."

   No written validation exists. Until one does, the brand stays out of everything that works
   as a name (product, id, repository, author, icons) and appears only as plain text that tells
   the reader what the plugin connects to.
2. **The marketing guideline** (<https://dev.netatmo.com/guideline>, "Naming") asks for "a name
   for your app which is not confusing with the Netatmo brand", names "Netatmo-Yourbrand" style
   mashups as examples to avoid, and asks for "a logo which is clearly different and not using any
   part of the Netatmo logo". Its "Wording" item asks not to imply a partnership, endorsement or
   affiliation. It also says that apps not complying with the policy "will be deactivated": the
   practical risk falls on the user's developer app, not only on this repository.
3. **The Netatmo brand kit** ("under certain conditions" the logo and product images may be used)
   was deliberately not downloaded and its conditions are unread. It is not used.
4. **Elgato/Corsair.** The Elgato Marketplace rules (no trademark infringement, no "Stream Deck"
   or "plugin" in a plugin name, no claims of being official) do not bind a sideloaded file, but
   are a sensible baseline, so they are followed. Whether Corsair would object to
   "Stream Deck" in a repository name is **[unverified]**; no statement forbidding it was found.
5. **EU/German trade mark law** (Art. 14 EUTMR, section 23 MarkenG) protects honest, necessary,
   descriptive references such as "compatible with X"; it does not protect using the mark as the
   product's own name or in a way that suggests affiliation. That points the same way:
   mention the brand as little and as plainly as needed. Using it as the product name would also
   conflict with the guideline above.
6. The UUID can never change once users have installed the plugin, so it carries no brand at all.
7. A purely descriptive name costs discoverability; this is compensated by the README title, the
   manifest description and a `netatmo` repository topic, all plain descriptions.

Rejected names: anything containing Netatmo, "atmo" or "Deck" mashups. Considered and
not chosen: "Weather Station Dashboard", "Weather Station Monitor" (equally safe, less accurate).

## Non-commercial limit

The terms state: "Only non-commercial uses of the Netatmo Weather API are acceptable. Any
commercial use of the Netatmo Weather API is submitted to the prior and written authorisation
of Netatmo." Hence no ads, no paid features, no paywalled releases. Whether a donation or sponsor
link counts as commercial is a grey area **[unverified]**; the safe choice is to have none, and
the repository has none. The terms also say the app key must stay confidential and must not be
shared, which is why each user brings their own developer app ([SETUP.md](SETUP.md)).

## Checklist (keep green)

- [ ] No "Netatmo", "Legrand", "Elgato", "Corsair", "Stream Deck" or "plugin" in manifest `Name`,
      `Category`, `Author`, UUIDs; no "Netatmo", "Legrand", "Elgato" or "Corsair" in the npm
      package name or repository name; "Stream Deck" there only as the descriptive slug
      `stream-deck-home-weather-station` (test: `tests/branding.test.ts`).
- [ ] "Netatmo" only in running text as a compatibility statement; never styled as a logo, heading
      brand or hero text. Headings and titles in the Property Inspector are brand-free (the
      credential section is "Weather station account"; test: `tests/branding.test.ts`); the
      brand may appear in descriptive hint paragraphs there ("Create your own app in the
      Netatmo developer portal") and in the non-affiliation notice. Headings of this
      repository's documents avoid the brand.
- [ ] No Netatmo logo, brand colours as identity, product photos or screenshots of Netatmo apps in
      the repository, README or releases; no Elgato logo or device photos.
- [ ] Icons: Lucide (ISC, plus MIT where Feather-derived) with licence file next to them; generated
      artwork follows docs/RENDERING.md and its prompts contain no brand name.
- [ ] NOTICE has the trademark paragraph; README starts with the non-affiliation notice.
- [ ] Wording: "unofficial", "independent", "works with"; never "official", "certified", "partner",
      "powered by", "in cooperation with".
- [ ] "Stream Deck" is two words, "plugin" has no hyphen, "Elgato" has a lowercase g.
- [ ] Strictly non-commercial; no donation or sponsor links.
- [ ] Bring-your-own developer app: no shared client id/secret in the repository or the package.
- [ ] No user credentials are stored (tokens only); rate limits respected; README tells users that
      Netatmo may change or block the API.
- [ ] Every release's notes repeat the first two sentences of the README notice; no Netatmo brand
      kit files are attached.
- [ ] No Marketplace listing. If that changes, redo the Elgato guideline check
      ([PUBLISHING.md](PUBLISHING.md)).

## Optional: request for written validation (DRAFT, NOT SENT)

Sending this is the owner's decision. The contact address is shown on the Netatmo Connect
pages; it is deliberately not written into this repository. A reply, if any, should be stored
by the owner (not in the repository if it contains personal data) and recorded here as a date
and a one-line outcome.

```text
Subject: Request for confirmation: unofficial open-source Stream Deck plugin using the Weather API

Hello,
I plan to publish a free, non-commercial, open-source plugin for Elgato Stream Deck
on GitHub (not on the Elgato Marketplace). It reads data from the user's own
Netatmo weather station via the Netatmo Weather API, using the user's own
developer app. The plugin is called "Home Weather Station". The word "Netatmo"
appears only in the description and README, in sentences such as "works with a
Netatmo weather station", together with a notice that the project is unofficial and
not affiliated with Netatmo. I use no Netatmo logo, product images or brand colours.
Section PROPERTY of your API terms asks for written validation of any use of the
brand. Could you confirm that this use is acceptable?
Thank you,
<name>
```

## Open items

- Written validation from Netatmo: not requested, not received. The project distributes without it
  and relies on keeping the brand to plain compatibility text. Whether that satisfies the clause
  is the owner's risk call.
- Netatmo brand kit conditions: unread.
- Whether any standalone Netatmo/Legrand trademark policy exists beyond the API terms: not found,
  **[unverified]** that none exists.
- Corsair's view of "Stream Deck" in the repository name: **[unverified]**.
- Whether established projects that use the brand openly have written approval: unknown.
- Statements about EU and German law above are a lay summary of the cited provisions, section 14
  MarkenG and the unfair-competition act were not read.

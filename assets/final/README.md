# Artwork sources (committed, maintainer review pending)

* `plugin-icon-source.png`: 1024x1024 source of the plugin icon. AI-generated original
  artwork (Codex CLI image tool). Looked at by an AI agent during generation and by the
  integrating AI assistant, for logos, text and device imagery; **not yet looked at by the
  maintainer** (to be done before a release, see `docs/RENDERING.md`). Regenerate the shipped
  256/512 px files with `python3 -I scripts/finalize-assets.py`.
* `previews/`: illustrative key tiles for the documentation, drawn by Codex as SVG with
  placeholder values. They show no real data and are not a picture of any Stream Deck
  device.

Provenance, prompts and review notes: `docs/RENDERING.md`.

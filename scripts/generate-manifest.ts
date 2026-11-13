#!/usr/bin/env tsx
/**
 * Write manifest.json from the action catalog (src/actions/catalog.ts).
 *
 * `Version` and `Nodejs.Debug` are carried over from the existing file because
 * scripts/sync-manifest-version.ts owns them. Everything else is regenerated.
 *
 * Usage: npm run generate:manifest
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildManifest, serialiseManifest } from "./lib/manifest.ts";
import { MANIFEST_PATH } from "./lib/plugin-id.ts";

const existing = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) : undefined;
const manifest = buildManifest(existing);
writeFileSync(MANIFEST_PATH, serialiseManifest(manifest), "utf-8");
console.log(`Wrote manifest with ${manifest.Actions.length} actions to ${MANIFEST_PATH}`);

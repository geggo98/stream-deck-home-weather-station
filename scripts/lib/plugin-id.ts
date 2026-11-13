/**
 * Plugin identity for the build scripts.
 *
 * The same id lives in `src/actions/catalog.ts` for the runtime; the two are kept in
 * step by tests/catalog-manifest.test.ts. It is repeated here only because scripts run
 * under tsx and must not pull in the whole action layer to learn a folder name.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Reverse-DNS plugin id; also the `.sdPlugin` folder name and every action UUID prefix. */
export const PLUGIN_ID = "de.schwetschke.sd.home-weather-station";

export const PLUGIN_DIR_NAME = `${PLUGIN_ID}.sdPlugin`;

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PLUGIN_DIR = resolve(PROJECT_ROOT, PLUGIN_DIR_NAME);
export const MANIFEST_PATH = resolve(PLUGIN_DIR, "manifest.json");

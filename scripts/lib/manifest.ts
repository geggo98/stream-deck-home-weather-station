/**
 * Pure construction of manifest.json from the action catalog.
 *
 * The generator script writes the result; tests/catalog-manifest.test.ts calls the same
 * functions and compares with the committed file, so the manifest cannot drift from the
 * catalog (and with it from the UUIDs registered in code).
 *
 * Wording rules (docs/ARCHITECTURE.md, "Brand hygiene"): the brand names of the data
 * source and of the hardware vendors do not appear in Name, Category, Author or any UUID.
 * The Description names the data source once, as a compatibility statement, together with
 * the non-affiliation notice.
 */

import {
	DIAL_SPECS,
	FOCUS_SPECS,
	KEYPAD_SPECS,
	PLUGIN_ID,
	iconPath,
	keyImagePath,
	uuidFor,
	type ActionId,
} from "../../src/actions/catalog.ts";

export interface ManifestState {
	Image: string;
	TitleAlignment: "bottom" | "middle" | "top";
}

export interface ManifestAction {
	Name: string;
	UUID: string;
	Icon: string;
	Tooltip: string;
	Controllers: string[];
	PropertyInspectorPath?: string;
	States: ManifestState[];
	Encoder?: {
		layout: string;
		Icon: string;
		TriggerDescription: { Push: string; Rotate: string; Touch: string };
	};
}

export interface Manifest {
	Name: string;
	UUID: string;
	Version: string;
	Author: string;
	URL: string;
	Description: string;
	Icon: string;
	Category: string;
	CategoryIcon: string;
	CodePath: string;
	Nodejs: { Version: string; Debug?: string };
	Software: { MinimumVersion: string };
	OS: Array<{ Platform: string; MinimumVersion: string }>;
	SDKVersion: number;
	Actions: ManifestAction[];
}

export const PLUGIN_NAME = "Home Weather Station";

export const PLUGIN_DESCRIPTION =
	"Shows indoor and outdoor temperature, humidity, CO2, noise, pressure, rain, wind and trends from a Netatmo weather station on your keys. " +
	"Unofficial: independent project, not affiliated with or endorsed by Netatmo, Elgato or Corsair.";

/** Placeholder until sync-manifest-version.ts derives the real one from package.json. */
export const INITIAL_VERSION = "0.1.0.0";

/** The key picture is a placeholder: the real face is composed at runtime. The title sits at the bottom. */
function states(id: ActionId): ManifestState[] {
	return [{ Image: keyImagePath(id), TitleAlignment: "bottom" }];
}

export function buildActions(): ManifestAction[] {
	const keys: ManifestAction[] = KEYPAD_SPECS.map((spec) => ({
		Name: spec.name,
		UUID: uuidFor(spec.id),
		Icon: iconPath(spec.id),
		Tooltip: spec.tooltip,
		Controllers: ["Keypad"],
		PropertyInspectorPath: spec.propertyInspector,
		States: states(spec.id),
	}));
	// The focus family: some keys have settings (a Property Inspector page), the navigation keys none.
	const focus: ManifestAction[] = FOCUS_SPECS.map((spec) => {
		const action: ManifestAction = {
			Name: spec.name,
			UUID: uuidFor(spec.id),
			Icon: iconPath(spec.id),
			Tooltip: spec.tooltip,
			Controllers: ["Keypad"],
			States: states(spec.id),
		};
		if ("propertyInspector" in spec) action.PropertyInspectorPath = spec.propertyInspector;
		return action;
	});
	const dials: ManifestAction[] = DIAL_SPECS.map((spec) => ({
		Name: spec.name,
		UUID: uuidFor(spec.id),
		Icon: iconPath(spec.id),
		Tooltip: spec.tooltip,
		Controllers: ["Encoder"],
		PropertyInspectorPath: spec.propertyInspector,
		States: states(spec.id),
		Encoder: {
			layout: spec.encoderLayout,
			Icon: iconPath(spec.id),
			TriggerDescription: { ...spec.trigger },
		},
	}));
	return [...keys, ...focus, ...dials];
}

/**
 * The whole manifest. `Version` and `Nodejs.Debug` belong to sync-manifest-version.ts and
 * are carried over from the existing file; `Nodejs.Debug` is otherwise absent (never
 * "disabled": Stream Deck then refuses to launch the plugin at all).
 */
export function buildManifest(existing?: Partial<Pick<Manifest, "Version">> & { Nodejs?: { Debug?: string } }): Manifest {
	const nodejs: Manifest["Nodejs"] = { Version: "24" };
	if (existing?.Nodejs?.Debug !== undefined) nodejs.Debug = existing.Nodejs.Debug;
	return {
		Name: PLUGIN_NAME,
		UUID: PLUGIN_ID,
		Version: existing?.Version ?? INITIAL_VERSION,
		Author: "Stefan Schwetschke",
		URL: "https://github.com/geggo98/stream-deck-home-weather-station",
		Description: PLUGIN_DESCRIPTION,
		Icon: "imgs/plugin/plugin-icon",
		Category: PLUGIN_NAME,
		CategoryIcon: "imgs/plugin/category-icon",
		CodePath: "bin/plugin.js",
		Nodejs: nodejs,
		Software: { MinimumVersion: "7.1" },
		OS: [
			{ Platform: "mac", MinimumVersion: "12" },
			{ Platform: "windows", MinimumVersion: "10" },
		],
		SDKVersion: 3,
		Actions: buildActions(),
	};
}

export function serialiseManifest(manifest: Manifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

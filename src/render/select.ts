/**
 * Choosing a module out of a snapshot. Pure.
 *
 * A module key is "<stationId>|<moduleId>", as written by the Property Inspector's
 * module dropdown. Both parts are API identifiers: they are only ever compared, never
 * rendered and never logged at INFO.
 */

import type { ModuleData, StationData, StationSnapshot } from "../adapter/station/types.ts";
import { METRICS, moduleReports, type DisplayMetricId } from "./metrics.ts";

export const MODULE_KEY_SEPARATOR = "|";

export function makeModuleKey(stationId: string, moduleId: string): string {
	return `${stationId}${MODULE_KEY_SEPARATOR}${moduleId}`;
}

export function parseModuleKey(key: string | undefined): { stationId: string; moduleId: string } | undefined {
	if (typeof key !== "string") return undefined;
	const at = key.indexOf(MODULE_KEY_SEPARATOR);
	if (at <= 0 || at === key.length - 1) return undefined;
	return { stationId: key.slice(0, at), moduleId: key.slice(at + 1) };
}

export interface SelectedModule {
	readonly station: StationData;
	readonly module: ModuleData;
	readonly key: string;
}

/** The module a key points at, or undefined when it is gone from the account. */
export function findModule(snapshot: StationSnapshot, key: string | undefined): SelectedModule | undefined {
	const parsed = parseModuleKey(key);
	if (!parsed) return undefined;
	for (const station of snapshot.stations) {
		if (station.id !== parsed.stationId) continue;
		const module = station.modules.find((m) => m.id === parsed.moduleId);
		if (module) return { station, module, key: makeModuleKey(station.id, module.id) };
	}
	return undefined;
}

/**
 * The module a freshly dropped action adopts: the first station's base station if it
 * reports the wanted metric, otherwise the first module anywhere that does, otherwise
 * simply the first base station (so the key shows "No data" rather than "No module").
 */
export function adoptionCandidate(snapshot: StationSnapshot, metric: DisplayMetricId): SelectedModule | undefined {
	const def = METRICS[metric];
	let firstBase: SelectedModule | undefined;
	let firstReporting: SelectedModule | undefined;
	for (const station of snapshot.stations) {
		for (const module of station.modules) {
			const selected: SelectedModule = { station, module, key: makeModuleKey(station.id, module.id) };
			if (module.role === "base") {
				firstBase ??= selected;
				if (moduleReports(module.values, def)) return selected;
			}
			if (!firstReporting && moduleReports(module.values, def)) firstReporting = selected;
		}
	}
	return firstReporting ?? firstBase;
}

/**
 * Navigation over the focus `(station, module, metric)`. Pure and SDK-free.
 *
 * The focus is the plugin-wide cursor that follower keys and the dial display. Every
 * function takes the snapshot and a (possibly stale) focus and returns a NEW focus plus
 * `blocked`: true means there was nothing to move to (the focus came back unchanged and the
 * key should flash an alert instead of repainting). None of them throws, whatever the focus
 * or the snapshot looks like: a stored focus can name a module that has vanished since.
 *
 * Order of metrics is the dial order of src/render/metrics.ts; modules and stations keep the
 * order the API delivered them in. Everything wraps around.
 */

import type { MetricKey, ModuleData, StationData, StationSnapshot } from "../adapter/station/types.ts";
import { DIAL_METRIC_ORDER, METRICS, metricsReportedBy, moduleReports, type DisplayMetricId } from "../render/metrics.ts";
import { makeModuleKey } from "../render/select.ts";

export interface Focus {
	readonly stationId: string;
	readonly moduleId: string;
	readonly metric: MetricKey;
}

export type Direction = 1 | -1;

export interface NavResult {
	readonly focus: Focus;
	/** Nothing to move to: `focus` is the (resolved) input. */
	readonly blocked: boolean;
}

/** Ids are API identifiers (MAC addresses); anything longer than this is not one. */
const MAX_ID_CHARS = 64;

const BY_SOURCE = new Map<MetricKey, DisplayMetricId>(DIAL_METRIC_ORDER.map((id) => [METRICS[id].source, id]));

/** The display metric that reads this measurement, or undefined for measurements that have none (min/max, trends, angles). */
export function displayMetricOf(metric: MetricKey): DisplayMetricId | undefined {
	return BY_SOURCE.get(metric);
}

export function metricKeyOf(id: DisplayMetricId): MetricKey {
	return METRICS[id].source;
}

export function sameFocus(a: Focus | undefined, b: Focus | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.stationId === b.stationId && a.moduleId === b.moduleId && a.metric === b.metric);
}

/** Validate something read from settings. Unknown shapes give undefined, never an exception. */
export function parseFocus(raw: unknown): Focus | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const { stationId, moduleId, metric } = raw as Record<string, unknown>;
	const idOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS;
	if (!idOk(stationId) || !idOk(moduleId) || typeof metric !== "string") return undefined;
	if (!BY_SOURCE.has(metric as MetricKey)) return undefined;
	return { stationId, moduleId, metric: metric as MetricKey };
}

export interface Located {
	readonly station: StationData;
	readonly module: ModuleData;
}

/** The module a focus points at, or undefined when it is gone. */
export function locate(snapshot: StationSnapshot, focus: Pick<Focus, "stationId" | "moduleId">): Located | undefined {
	const station = snapshot.stations.find((s) => s.id === focus.stationId);
	const module = station?.modules.find((m) => m.id === focus.moduleId);
	return station && module ? { station, module } : undefined;
}

export function focusModuleKey(focus: Focus): string {
	return makeModuleKey(focus.stationId, focus.moduleId);
}

function baseOf(station: StationData): ModuleData | undefined {
	return station.modules.find((m) => m.role === "base") ?? station.modules[0];
}

function landOn(station: StationData, wanted: MetricKey | undefined): Focus | undefined {
	const base = baseOf(station);
	if (!base) return undefined;
	const reported = metricsReportedBy(base.values);
	const wantedId = wanted === undefined ? undefined : displayMetricOf(wanted);
	const id = wantedId !== undefined && reported.includes(wantedId) ? wantedId : (reported[0] ?? "temperature");
	return { stationId: station.id, moduleId: base.id, metric: metricKeyOf(id) };
}

/**
 * Repair a stored focus: keep it when its module still exists (a metric the module does not
 * report any more becomes its first one), otherwise fall back to the first station's base
 * module and its temperature. undefined only when the snapshot has no module at all.
 */
export function resolveFocus(snapshot: StationSnapshot | undefined, stored: unknown): Focus | undefined {
	if (!snapshot) return undefined;
	const parsed = parseFocus(stored);
	if (parsed) {
		const at = locate(snapshot, parsed);
		if (at) {
			const reported = metricsReportedBy(at.module.values);
			const id = displayMetricOf(parsed.metric);
			if (id !== undefined && reported.includes(id)) return parsed;
			if (reported.length > 0) return { ...parsed, metric: metricKeyOf(reported[0]!) };
			return parsed;
		}
	}
	for (const station of snapshot.stations) {
		const landed = landOn(station, "temperature");
		if (landed) return landed;
	}
	return undefined;
}

function wrap(index: number, length: number): number {
	return ((index % length) + length) % length;
}

/** Next / previous metric THIS module reports. */
export function nextMetric(snapshot: StationSnapshot | undefined, stored: unknown, dir: Direction): NavResult | undefined {
	const parsed = parseFocus(stored);
	const resolved = resolveFocus(snapshot, stored);
	if (!snapshot || !resolved) return undefined;
	// A stored metric the (existing) module does not report: the first step lands on an end of
	// the list instead of skipping an entry. resolveFocus has already replaced such a metric,
	// so look at what was stored.
	const at = locate(snapshot, resolved);
	if (!at) return { focus: resolved, blocked: true };
	const list = metricsReportedBy(at.module.values);
	if (list.length === 0) return { focus: resolved, blocked: true };
	const storedId = parsed && parsed.stationId === resolved.stationId && parsed.moduleId === resolved.moduleId ? displayMetricOf(parsed.metric) : displayMetricOf(resolved.metric);
	const found = storedId === undefined ? -1 : list.indexOf(storedId);
	const target = found === -1 ? list[dir > 0 ? 0 : list.length - 1]! : list[wrap(found + dir, list.length)]!;
	const focus: Focus = { ...resolved, metric: metricKeyOf(target) };
	// Landing on an end from a metric the module does not report is a move; one metric is not.
	return { focus, blocked: found !== -1 && list.length < 2 };
}

/** Next / previous module of the same station that reports the focused metric; others are skipped. */
export function nextModule(snapshot: StationSnapshot | undefined, stored: unknown, dir: Direction): NavResult | undefined {
	const resolved = resolveFocus(snapshot, stored);
	if (!snapshot || !resolved) return undefined;
	const at = locate(snapshot, resolved);
	const id = displayMetricOf(resolved.metric);
	if (!at || id === undefined) return { focus: resolved, blocked: true };
	const modules = at.station.modules;
	const start = modules.findIndex((m) => m.id === resolved.moduleId);
	for (let step = 1; step < modules.length; step++) {
		const candidate = modules[wrap(start + dir * step, modules.length)]!;
		if (moduleReports(candidate.values, METRICS[id])) {
			return { focus: { ...resolved, moduleId: candidate.id }, blocked: false };
		}
	}
	return { focus: resolved, blocked: true };
}

/** Next / previous station; lands on its base module, keeping the metric when the base reports it. */
export function nextStation(snapshot: StationSnapshot | undefined, stored: unknown, dir: Direction): NavResult | undefined {
	const resolved = resolveFocus(snapshot, stored);
	if (!snapshot || !resolved) return undefined;
	const stations = snapshot.stations.filter((s) => s.modules.length > 0);
	const start = stations.findIndex((s) => s.id === resolved.stationId);
	if (stations.length < 2 || start === -1) return { focus: resolved, blocked: true };
	const target = stations[wrap(start + dir, stations.length)]!;
	const landed = landOn(target, resolved.metric);
	return landed ? { focus: landed, blocked: false } : { focus: resolved, blocked: true };
}

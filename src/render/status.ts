/**
 * What a key may show, as a pure function of connection state, snapshot and clock.
 *
 * There is deliberately no second write path that sets "Offline" or "Sign in" and could
 * outlive the outage: every repaint recomputes this, so the face recovers by itself
 * (see docs/ARCHITECTURE.md, "Status is a pure function").
 *
 * Freshness comes from the measurement time and the clock, NOT from `reachable`, which
 * lags real outages by up to four hours.
 */

import type { ConnectionState, Freshness, ModuleData, StationSnapshot } from "../adapter/station/types.ts";
import { UNPERSISTED_ROTATION_MESSAGE } from "../adapter/station/token-manager.ts";
import { METRICS, type DisplayMetricId } from "./metrics.ts";
import { adoptionCandidate, findModule, type SelectedModule } from "./select.ts";

/** A reading older than this is drawn dimmed with an age hint. Netatmo measures about every 10 minutes. */
export const STALE_AFTER_MS = 25 * 60 * 1000;

export function moduleFreshness(module: ModuleData, now: number): Freshness {
	if (module.measuredAt === null) return module.reachable ? "unknown" : "unreachable";
	const age = now - module.measuredAt;
	if (age <= STALE_AFTER_MS) return "fresh";
	return module.reachable ? "stale" : "unreachable";
}

export type Classification =
	| { readonly kind: "no-service" }
	| { readonly kind: "no-credentials" }
	| { readonly kind: "auth-error" }
	| { readonly kind: "loading" }
	| { readonly kind: "offline" }
	| { readonly kind: "no-module" }
	| { readonly kind: "unreachable"; readonly selected: SelectedModule }
	| { readonly kind: "no-data"; readonly selected: SelectedModule }
	| {
			readonly kind: "value";
			readonly selected: SelectedModule;
			readonly value: number;
			readonly stale: boolean;
			/** Age of the reading in ms when known; drives the age hint. */
			readonly ageMs: number | undefined;
	  };

export interface ClassifyInput {
	readonly hasSource: boolean;
	readonly connection: ConnectionState;
	readonly snapshot: StationSnapshot | undefined;
	readonly moduleKey: string | undefined;
	readonly metric: DisplayMetricId;
	readonly now: number;
}

/**
 * The adapter reports "the renewed sign-in could not be saved" as an `error` connection state
 * while data keeps flowing. The data is current, so nothing may be dimmed or aged because of it;
 * the message belongs in the account status of the Property Inspector instead.
 */
export function isUnpersistedRotation(connection: ConnectionState): boolean {
	return connection.kind === "error" && connection.message === UNPERSISTED_ROTATION_MESSAGE;
}

/** True when the cached data may be out of date because the last poll failed. */
export function hasCachedError(connection: ConnectionState): boolean {
	return connection.kind === "error" && !isUnpersistedRotation(connection);
}

export type ConnectionStatus = Extract<Classification["kind"], "no-service" | "no-credentials" | "auth-error" | "loading" | "offline">;

/** The status that overrides everything else, or undefined when data may be shown. */
export function classifyConnection(
	hasSource: boolean,
	connection: ConnectionState,
	snapshot: StationSnapshot | undefined,
): ConnectionStatus | undefined {
	if (!hasSource) return "no-service";
	// Status beats metadata: these two stop everything else, even with a cached snapshot.
	if (connection.kind === "no-credentials") return "no-credentials";
	if (connection.kind === "auth-error") return "auth-error";
	if (!snapshot) return hasCachedError(connection) ? "offline" : "loading";
	return undefined;
}

export function classify(input: ClassifyInput): Classification {
	const overriding = classifyConnection(input.hasSource, input.connection, input.snapshot);
	if (overriding) return { kind: overriding };
	if (!input.snapshot) return { kind: "loading" };
	const selected = input.moduleKey === undefined
		? adoptionCandidate(input.snapshot, input.metric)
		: findModule(input.snapshot, input.moduleKey);
	if (!selected) return { kind: "no-module" };

	const freshness = moduleFreshness(selected.module, input.now);
	if (freshness === "unreachable") return { kind: "unreachable", selected };
	const raw = selected.module.values[METRICS[input.metric].source];
	if (typeof raw !== "number" || !Number.isFinite(raw)) return { kind: "no-data", selected };

	const cachedError = hasCachedError(input.connection);
	return {
		kind: "value",
		selected,
		value: raw,
		stale: freshness !== "fresh" || cachedError,
		ageMs: selected.module.measuredAt === null ? undefined : Math.max(0, input.now - selected.module.measuredAt),
	};
}

/** "just now" below a minute, else like `formatAge`. */
export function formatAgeLong(ageMs: number): string {
	return ageMs < 60_000 ? "just now" : formatAge(ageMs);
}

/** "12 min", "3 h", "2 d": a short age for the stale hint. Rounds down. */
export function formatAge(ageMs: number): string {
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 60) return `${Math.max(1, minutes)} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h`;
	return `${Math.floor(hours / 24)} d`;
}

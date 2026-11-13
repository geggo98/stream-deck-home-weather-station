/**
 * Where the one `WeatherService` lives. plugin.ts creates it (at connect time, never at
 * import time, so a failing constructor cannot break the bundle load) and stores it here;
 * the actions read it through `getWeatherSource()`. SDK-free.
 */

import type { WeatherService } from "../adapter/station/service.ts";
import type { WeatherSource } from "../adapter/station/types.ts";

let service: WeatherService | undefined;

export function setWeatherService(next: WeatherService | undefined): void {
	service = next;
}

export function getWeatherService(): WeatherService | undefined {
	return service;
}

/** The read-only surface the actions need. */
export function getWeatherSource(): WeatherSource | undefined {
	return service;
}

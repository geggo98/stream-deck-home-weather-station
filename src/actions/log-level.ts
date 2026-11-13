/**
 * The plugin's log level from the environment. SDK-free and pure, so a test can pin it.
 *
 * HOME_WEATHER_LOG_LEVEL wins; HOME_WEATHER_DEBUG (any non-empty value) means "debug"; the
 * default is "info". A value that is not one of the SDK's levels falls back to the default:
 * the SDK RESETS an out-of-range level to "info" on its own, so passing junk through would
 * only hide the typo.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogLevelChoice {
	readonly level: LogLevel;
	/** Set when HOME_WEATHER_LOG_LEVEL was given but is not a level; the caller logs it. */
	readonly ignored?: string;
}

export function chooseLogLevel(env: Readonly<Record<string, string | undefined>>): LogLevelChoice {
	const requested = env.HOME_WEATHER_LOG_LEVEL?.trim().toLowerCase();
	if (requested !== undefined && requested !== "") {
		const level = LOG_LEVELS.find((candidate) => candidate === requested);
		if (level) return { level };
		return { level: env.HOME_WEATHER_DEBUG ? "debug" : "info", ignored: requested.slice(0, 32) };
	}
	return { level: env.HOME_WEATHER_DEBUG ? "debug" : "info" };
}

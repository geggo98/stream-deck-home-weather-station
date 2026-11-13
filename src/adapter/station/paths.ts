/**
 * Per-user data directory for credentials.json. Kept apart from Stream Deck settings,
 * which are plain JSON in the user's profile and are dumped into the log at TRACE level.
 */

import os from "node:os";
import path from "node:path";

export const DATA_DIR_NAME = "home-weather-station";

export interface DataDirInputs {
	readonly platform?: NodeJS.Platform;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly home?: string;
}

/**
 * macOS  ~/Library/Application Support/home-weather-station
 * Windows %APPDATA%\home-weather-station
 * other  $XDG_CONFIG_HOME/home-weather-station or ~/.config/home-weather-station
 *
 * The XDG spec says relative values of XDG_CONFIG_HOME must be ignored, so they are.
 */
export function defaultDataDir(inputs: DataDirInputs = {}): string {
	const platform = inputs.platform ?? process.platform;
	const env = inputs.env ?? process.env;
	const home = inputs.home ?? os.homedir();
	if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", DATA_DIR_NAME);
	if (platform === "win32") {
		const appData = env.APPDATA && env.APPDATA.length > 0 ? env.APPDATA : path.win32.join(home, "AppData", "Roaming");
		return path.win32.join(appData, DATA_DIR_NAME);
	}
	const xdg = env.XDG_CONFIG_HOME;
	const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, ".config");
	return path.posix.join(base, DATA_DIR_NAME);
}

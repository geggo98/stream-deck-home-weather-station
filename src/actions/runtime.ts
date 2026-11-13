/**
 * The SDK-bound glue: the process-wide controllers and the PI router, built lazily so
 * that importing an action class has no side effect beyond registering it.
 *
 * Everything with logic lives in SDK-free modules (key-controller, dial-controller,
 * pi-router); this file only injects the SDK logger, the clock and the cached settings.
 */

import streamDeck from "@elgato/streamdeck";
import type { AdapterLogger } from "../adapter/logging.ts";
import { DialController } from "./dial-controller.ts";
import { FocusStore } from "../focus/focus-store.ts";
import { getCachedGlobalSettings, onGlobalSettingsChanged, updateGlobalSettings, waitForGlobalSettings } from "./global-settings.ts";
import { HistoryController } from "./history-controller.ts";
import { KeyController } from "./key-controller.ts";
import { NavController } from "./nav-controller.ts";
import { RepaintClock } from "./repaint-clock.ts";
import type { ControllerEnv } from "./controller-base.ts";
import type { PiRouter } from "./pi-router.ts";
import { getWeatherService, getWeatherSource } from "./service-holder.ts";

/** One clock for keys and dials together: a single 60 s timer, alive only while an action is visible. */
const repaintClock = new RepaintClock();

/** The plugin-wide focus, persisted through the settings funnel. */
const focusStore = new FocusStore({
	getGlobal: getCachedGlobalSettings,
	update: updateGlobalSettings,
	logger: streamDeck.logger as AdapterLogger,
});

export function getFocusStore(): FocusStore {
	return focusStore;
}

function makeEnv(): ControllerEnv {
	return {
		focus: focusStore,
		getHistory: (request) => getWeatherService()?.getHistory(request),
		getSource: getWeatherSource,
		now: () => Date.now(),
		logger: streamDeck.logger as AdapterLogger,
		getGlobal: getCachedGlobalSettings,
		waitForSettings: () => waitForGlobalSettings(),
		onGlobalChange: onGlobalSettingsChanged,
		clock: repaintClock,
	};
}

let keys: KeyController | undefined;
let dials: DialController | undefined;
let navs: NavController | undefined;
let histories: HistoryController | undefined;
let router: PiRouter | undefined;

export function keyController(): KeyController {
	keys ??= new KeyController(makeEnv());
	return keys;
}

export function dialController(): DialController {
	dials ??= new DialController(makeEnv());
	return dials;
}

export function navController(): NavController {
	navs ??= new NavController(makeEnv());
	return navs;
}

export function historyController(): HistoryController {
	histories ??= new HistoryController(makeEnv());
	return histories;
}

/** plugin.ts installs the router once the service factory and SDK senders are known. */
export function setPiRouter(next: PiRouter | undefined): void {
	router = next;
}

/** Forward a PI message; never throws (a rejected handler must not become an unhandled rejection). */
export async function routePiMessage(actionId: string, payload: unknown): Promise<void> {
	try {
		await router?.handle(actionId, payload);
	} catch (err) {
		streamDeck.logger.error(`PI message failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export function disposeControllers(): void {
	keys?.dispose();
	dials?.dispose();
	navs?.dispose();
	histories?.dispose();
}

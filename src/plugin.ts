import streamDeck from "@elgato/streamdeck";

import { setAdapterLogger } from "./adapter/logging.ts";
import { createWeatherService } from "./adapter/station/create-service.ts";
import { ACTION_IDS } from "./actions/catalog.ts";
import {
	asGlobalSettings,
	getCachedGlobalSettings,
	globalSettingsError,
	loadGlobalSettingsWithRetry,
	onGlobalSettingsChanged,
	pollIntervalOf,
	setCachedGlobalSettings,
	setGlobalSettingsWriter,
	updateGlobalSettings,
	getRememberedActionSettings,
	getRememberedDefaultMetric,
	isRememberedHistoryAction,
} from "./actions/global-settings.ts";
import { chooseLogLevel } from "./actions/log-level.ts";
import { createFocusActions } from "./actions/focus-keys.ts";
import { createKeypadActions } from "./actions/measurement-keys.ts";
import { createPiRouter } from "./actions/pi-router.ts";
import { disposeControllers, setPiRouter } from "./actions/runtime.ts";
import { getWeatherService, setWeatherService } from "./actions/service-holder.ts";
import { WeatherDialAction } from "./actions/weather-dial.ts";
import type { JsonValue } from "@elgato/utils";
import { PI_EVENTS, type GlobalSettings, type PluginToPiMessage } from "./pi-protocol.ts";

// Log level. TRACE makes the SDK dump every WebSocket frame, which means complete settings
// objects land in the plugin's log files (plaintext, up to 10 x 50 MB, routinely attached to
// bug reports). Ship at INFO; opt in with HOME_WEATHER_LOG_LEVEL / HOME_WEATHER_DEBUG.
//
// "trace" is unreachable in a release build: the SDK builds its logger with
// `minimumLevel: isDebugMode() ? "trace" : "debug"`, and an out-of-range level RESETS to
// "info" instead of clamping. So the honest ceiling off the `npm run watch` loop is
// "debug". (Observed in a sibling project against the SDK's own logger; not re-measured.)
const logLevel = chooseLogLevel(process.env);
streamDeck.logger.setLevel(logLevel.level);
if (logLevel.ignored !== undefined) streamDeck.logger.warn(`HOME_WEATHER_LOG_LEVEL="${logLevel.ignored}" is not a log level (error, warn, info, debug, trace); using "${logLevel.level}"`);

// Node runs with unhandled rejections fatal, and the SDK's own safety net is a
// `process.once("uncaughtException", ...)`: it absorbs exactly one escaped error and the
// second one kills the plugin, taking every key on the deck with it. Keep the process
// alive and leave a breadcrumb; a dead plugin is strictly worse than a logged fault.
process.on("unhandledRejection", (reason) => {
	streamDeck.logger.error(
		`Unhandled promise rejection (plugin kept running): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
	);
});
process.on("uncaughtException", (err) => {
	streamDeck.logger.error(`Uncaught exception (plugin kept running): ${err.stack ?? err.message}`);
});

// The adapter must not import the SDK (log rotation is an import side effect that races in
// parallel test processes); it logs through this injected logger.
setAdapterLogger(streamDeck.logger);

for (const keyAction of createKeypadActions()) streamDeck.actions.registerAction(keyAction);
for (const focusAction of createFocusActions()) streamDeck.actions.registerAction(focusAction);
streamDeck.actions.registerAction(new WeatherDialAction());
// The bundle test looks for this line: it comes after EVERY registration, and
// `registerAction` throws for a UUID that is missing from the manifest.
streamDeck.logger.info(`Home Weather Station: registered ${ACTION_IDS.length} actions`);

// The settings funnel: keep the cache fresh, hand the SDK writer to the (SDK-free) module.
streamDeck.settings.onDidReceiveGlobalSettings((ev) => setCachedGlobalSettings(asGlobalSettings(ev.settings)));
setGlobalSettingsWriter((gs) => streamDeck.settings.setGlobalSettings(gs as Parameters<typeof streamDeck.settings.setGlobalSettings>[0]));

streamDeck.connect().catch((err) => {
	streamDeck.logger.error(`Connecting to Stream Deck failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});

// The service is created here, at connect time, never at import time: a failing
// constructor then costs the data, not the bundle load (and the bundle test).
try {
	setWeatherService(createWeatherService({ logger: streamDeck.logger, pollIntervalSeconds: pollIntervalOf(getCachedGlobalSettings()) }));
} catch (err) {
	streamDeck.logger.error(`Weather service could not be created; keys will show "Offline": ${err instanceof Error ? err.message : String(err)}`);
}

// Poll interval follows the global settings (initial load, PI changes, external edits).
let appliedPollSeconds: number | undefined;
function applyPollInterval(): void {
	const seconds = pollIntervalOf(getCachedGlobalSettings());
	if (seconds === undefined || seconds === appliedPollSeconds) return;
	appliedPollSeconds = seconds;
	getWeatherService()?.setPollInterval(seconds);
}
onGlobalSettingsChanged(applyPollInterval);

/**
 * Our messages are interfaces; the SDK type is JsonValue, which interfaces do not satisfy.
 * Serialising is the honest conversion (it is what the SDK does next anyway) and needs no cast
 * of our types; `undefined` fields drop out here exactly as they would on the wire.
 */
function toPiPayload(message: PluginToPiMessage): JsonValue {
	return JSON.parse(JSON.stringify(message));
}

const router = createPiRouter({
	getService: getWeatherService,
	reply: (message) => streamDeck.ui.sendToPropertyInspector(toPiPayload(message)),
	openUrl: (url) => streamDeck.system.openUrl(url),
	getActionSettings: getRememberedActionSettings,
	getActionDefaultMetric: getRememberedDefaultMetric,
	isHistoryAction: isRememberedHistoryAction,
	getGlobal: getCachedGlobalSettings,
	getGlobalError: globalSettingsError,
	updateGlobal: updateGlobalSettings,
	logger: streamDeck.logger,
});
setPiRouter(router);

// Push account status to an open PI. Subscribing counts as a subscriber (the poller starts
// with the first one), so it only exists while a PI is actually visible.
let stopStatusPush: (() => void) | undefined;
streamDeck.ui.onDidAppear(() => {
	stopStatusPush?.();
	const service = getWeatherService();
	if (!service) return;
	const subscription = service.subscribe(() => {
		router
			.accountStatus()
			.then((status) => streamDeck.ui.sendToPropertyInspector(toPiPayload({ event: PI_EVENTS.accountStatus, status, ...status })))
			.catch((err) => streamDeck.logger.warn(`status push failed: ${err instanceof Error ? err.message : String(err)}`));
	});
	stopStatusPush = () => subscription.unsubscribe();
});
streamDeck.ui.onDidDisappear(() => {
	stopStatusPush?.();
	stopStatusPush = undefined;
});

// Load persisted global settings once connected.
// Retried; when it still fails the PI says so (globalSettings.error) instead of silently
// snapping every change back.
void loadGlobalSettingsWithRetry(() => streamDeck.settings.getGlobalSettings(), { logger: streamDeck.logger });

function shutdown(): void {
	disposeControllers();
	stopStatusPush?.();
	getWeatherService()?.dispose();
}
process.once("exit", shutdown);

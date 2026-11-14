/**
 * The Value Dial (see dial-controller.ts for what it does). A thin class: the event wiring is
 * shared in weather-dial.ts.
 *
 * UNVERIFIED on hardware: no Stream Deck + was available while writing this.
 */

import { action } from "@elgato/streamdeck";
import { uuidFor } from "./catalog.ts";
import { DialActionBase } from "./weather-dial.ts";

@action({ UUID: uuidFor("weather-dial-value") })
export class ValueDialAction extends DialActionBase {
	protected readonly mode = "value";
}

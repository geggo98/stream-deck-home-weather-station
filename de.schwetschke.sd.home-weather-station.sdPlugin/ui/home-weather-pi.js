/**
 * Shared Property Inspector helpers for both pages (measurement.html, dial.html).
 *
 * Load order in each page:  vendor/sdpi-components.js -> home-weather-pi.js -> init/<page>.js
 * The per-page init file is a separate script because the pages carry a Content
 * Security Policy that refuses inline script.
 *
 * Rules this file keeps (tests/pi-*.test.ts check them):
 *  - Secrets (client secret, refresh token) are read from plain inputs that carry NO
 *    `setting=` binding, sent once with `sendToPlugin`, and the inputs are emptied in
 *    the same click handler. They are never stored in Stream Deck settings, never
 *    rendered back and never logged. This file has no console calls at all.
 *  - Every piece of text that comes from the plugin goes in with `textContent`, never
 *    as markup (it may contain account-controlled names).
 *  - Event names are string literals identical to PI_EVENTS in src/pi-protocol.ts.
 *  - Nothing here claims a live API test: no real Stream Deck and no real credentials
 *    were available when this was written.
 *
 * The pure functions are exported on `window.HomeWeatherPI` so the tests can run this
 * file in a `node:vm` sandbox without a browser.
 */
(function () {
	"use strict";

	/** Must stay identical to PI_EVENTS in src/pi-protocol.ts (tests/pi-protocol.test.ts). */
	const EVENTS = {
		getAccountStatus: "getAccountStatus",
		setCredentials: "setCredentials",
		clearCredentials: "clearCredentials",
		refreshNow: "refreshNow",
		startBrowserLogin: "startBrowserLogin",
		getModules: "getModules",
		getMetrics: "getMetrics",
		accountStatus: "accountStatus",
		credentialsResult: "credentialsResult",
		browserLogin: "browserLogin",
		getGlobalSettings: "getGlobalSettings",
		setGlobalSettings: "setGlobalSettings",
		globalSettings: "globalSettings",
	};

	/** How long to wait for the plugin before saying that it is not answering. */
	const PLUGIN_TIMEOUT_MS = 6000;
	/** A pending save re-enables its button after this long even without an answer. */
	const SAVE_TIMEOUT_MS = 20000;
	/** The two-step "Clear" reverts to its normal label after this long. */
	const CLEAR_ARM_MS = 4000;
	/** Text from the plugin is shown clipped; it is meant to be a short sentence. */
	const MAX_TEXT = 240;
	/** Upper bound for a pasted credential. Real ones are far shorter. */
	const MAX_CREDENTIAL_LENGTH = 4096;

	/* ------------------------------------------------------------------ */
	/* Pure functions                                                      */
	/* ------------------------------------------------------------------ */

	function clip(value, max) {
		const text = typeof value === "string" ? value : "";
		return text.length > max ? text.slice(0, max - 1) + "…" : text;
	}

	function plural(n, one, many) {
		return n + " " + (n === 1 ? one : many);
	}

	function defaultFormatTime(iso) {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return "";
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	/**
	 * Turn an AccountStatus into the text and colour class of the status line.
	 * The class carries the state, the words say it too (no colour-only signal).
	 */
	function describeStatus(status, formatTime) {
		if (!status || typeof status !== "object" || typeof status.state !== "string") {
			return { text: "Waiting for the plugin…", cls: "pi-status-unknown" };
		}
		const message = clip(status.message, MAX_TEXT);
		const hint = typeof status.clientIdHint === "string" && status.clientIdHint ? clip(status.clientIdHint, 12) : "";
		switch (status.state) {
			case "not-configured":
				return { text: "Not set up yet. Enter your credentials below.", cls: "pi-status-warn" };
			case "loading":
				return { text: "Connecting…", cls: "pi-status-unknown" };
			case "ok": {
				const parts = [];
				if (Number.isFinite(status.stationCount)) parts.push(plural(status.stationCount, "station", "stations"));
				if (Number.isFinite(status.moduleCount)) parts.push(plural(status.moduleCount, "module", "modules"));
				if (typeof status.lastUpdate === "string") {
					const time = (formatTime || defaultFormatTime)(status.lastUpdate);
					if (time) parts.push("updated " + time);
				}
				if (hint) parts.push("app ending " + hint);
				return { text: "Connected" + (parts.length ? ": " + parts.join(", ") : ""), cls: "pi-status-ok" };
			}
			case "error":
				return {
					text: "Temporary problem" + (message ? ": " + message : ". Trying again later."),
					cls: "pi-status-warn",
				};
			case "auth-error":
				return {
					text: "Sign-in needed" + (message ? ": " + message : ". Save your credentials again."),
					cls: "pi-status-error",
				};
			default:
				return { text: "Waiting for the plugin…", cls: "pi-status-unknown" };
		}
	}

	function hasWhitespace(value) {
		return /\s/.test(value);
	}

	/**
	 * Validate what the user typed. Trims the ends only; whitespace INSIDE a credential
	 * means a bad paste (a line break, two tokens) and is rejected rather than "fixed".
	 * The error text never contains the values.
	 */
	function buildCredentialsMessage(values) {
		const clientId = String((values && values.clientId) || "").trim();
		const clientSecret = String((values && values.clientSecret) || "").trim();
		const refreshToken = String((values && values.refreshToken) || "").trim();
		const missing = [];
		if (!clientId) missing.push("Client ID");
		if (!clientSecret) missing.push("Client secret");
		if (!refreshToken) missing.push("Refresh token");
		if (missing.length) return { ok: false, error: "Please fill in: " + missing.join(", ") + "." };
		for (const [name, value] of [
			["Client ID", clientId],
			["Client secret", clientSecret],
			["Refresh token", refreshToken],
		]) {
			if (hasWhitespace(value)) return { ok: false, error: name + " contains spaces or line breaks. Copy it again." };
			if (value.length > MAX_CREDENTIAL_LENGTH) return { ok: false, error: name + " is too long." };
		}
		return { ok: true, message: { event: EVENTS.setCredentials, clientId, clientSecret, refreshToken } };
	}

	/** The experimental browser sign-in needs the app's id and secret, but no token. */
	function buildBrowserLoginMessage(values) {
		const clientId = String((values && values.clientId) || "").trim();
		const clientSecret = String((values && values.clientSecret) || "").trim();
		const missing = [];
		if (!clientId) missing.push("Client ID");
		if (!clientSecret) missing.push("Client secret");
		if (missing.length) return { ok: false, error: "Please fill in: " + missing.join(", ") + "." };
		if (hasWhitespace(clientId) || hasWhitespace(clientSecret) || clientId.length > MAX_CREDENTIAL_LENGTH || clientSecret.length > MAX_CREDENTIAL_LENGTH) {
			return { ok: false, error: "Client ID or secret looks wrong. Copy it again." };
		}
		return { ok: true, message: { event: EVENTS.startBrowserLogin, clientId, clientSecret } };
	}

	/**
	 * The manual escape hatch for the module dropdown: "<stationId>|<moduleId>".
	 * Empty input is valid (it means "first base station"); anything else needs two
	 * non-empty halves around exactly one bar.
	 */
	function parseModuleKey(text) {
		const value = String(text || "").trim();
		if (!value) return { valid: true, empty: true };
		const parts = value.split("|");
		if (parts.length !== 2) return { valid: false };
		const station = parts[0].trim();
		const module = parts[1].trim();
		if (!station || !module || hasWhitespace(station) || hasWhitespace(module)) return { valid: false };
		return { valid: true, empty: false, station, module };
	}

	/** Entries a user can actually pick (leaves with a value that are not disabled). */
	function countSelectable(items) {
		if (!Array.isArray(items)) return 0;
		let n = 0;
		for (const item of items) {
			if (!item || typeof item !== "object") continue;
			if (Array.isArray(item.children)) n += countSelectable(item.children);
			else if (typeof item.value === "string" && item.value !== "" && !item.disabled) n += 1;
		}
		return n;
	}

	/** What to tell the user about a datasource reply (getModules / getMetrics). */
	function describeDatasourceReply(message) {
		if (countSelectable(message && message.items) > 0) return { kind: "ok", text: "" };
		const state = message && message.status && message.status.state;
		switch (state) {
			case "not-configured":
				return { kind: "needs-account", text: "No account is set up yet. Enter your credentials in the account block below." };
			case "auth-error":
				return { kind: "needs-account", text: "Sign-in needed. Save your credentials again in the account block below." };
			case "loading":
				return { kind: "problem", text: "Still connecting. The list fills in once the first data has arrived." };
			case "error":
				return { kind: "problem", text: "The plugin could not fetch data just now. Try again later, or enter the module by hand below." };
			default:
				return { kind: "empty", text: "The list is empty. If your station should be there, enter the module by hand below." };
		}
	}

	/** sdpi hands over either `{ payload }` or the payload itself, depending on the path. */
	function payloadOf(ev) {
		if (ev && typeof ev === "object" && ev.payload && typeof ev.payload === "object") return ev.payload;
		return ev && typeof ev === "object" ? ev : null;
	}

	/** The plugin may send the status flat (`{event, state, ...}`) or wrapped (`{event, status}`). */
	function statusOf(message) {
		if (!message || typeof message !== "object") return undefined;
		if (message.status && typeof message.status === "object") return message.status;
		return typeof message.state === "string" ? message : undefined;
	}

	/* ------------------------------------------------------------------ */
	/* Environment                                                         */
	/* ------------------------------------------------------------------ */

	/** The sdpi client behind a minimal interface, or null when it is not there. */
	function sdpiClient() {
		try {
			const c = window.SDPIComponents && window.SDPIComponents.streamDeckClient;
			if (!c) return null;
			return {
				send: function (payload) {
					c.send("sendToPlugin", payload);
				},
				subscribe: function (fn) {
					c.sendToPropertyInspector.subscribe(function (ev) {
						fn(payloadOf(ev));
					});
				},
			};
		} catch (e) {
			return null;
		}
	}

	function defaultEnv() {
		return {
			doc: document,
			client: sdpiClient(),
			timers: { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) },
			formatTime: defaultFormatTime,
		};
	}

	/* ------------------------------------------------------------------ */
	/* Account block                                                       */
	/* ------------------------------------------------------------------ */

	/**
	 * Wire up the account block (identical markup in every page).
	 * `env` is injectable for tests: { doc, client, timers, formatTime }.
	 */
	function initAccount(env) {
		const e = env || defaultEnv();
		const doc = e.doc;
		const timers = e.timers;
		const client = e.client;
		const $ = function (id) {
			return doc.getElementById(id);
		};
		const el = {
			status: $("accountStatus"),
			result: $("accountResult"),
			clientId: $("clientId"),
			clientSecret: $("clientSecret"),
			refreshToken: $("refreshToken"),
			save: $("saveCredentials"),
			clear: $("clearCredentials"),
			refresh: $("refreshNow"),
			login: $("startBrowserLogin"),
			loginBox: $("browserLoginBox"),
			loginResult: $("browserLoginResult"),
			redirectUri: $("redirectUri"),
			poll: $("pollInterval"),
			units: $("globalUnits"),
		};
		if (!el.status || !el.save) return;

		function showStatus(status) {
			const d = describeStatus(status, e.formatTime);
			el.status.textContent = d.text;
			el.status.className = "pi-status " + d.cls;
		}

		function showResult(target, text, warn) {
			if (!target) return;
			target.textContent = text;
			target.className = warn ? "pi-warn" : "pi-hint";
		}

		function wipeSecrets() {
			if (el.clientId) el.clientId.value = "";
			if (el.clientSecret) el.clientSecret.value = "";
			if (el.refreshToken) el.refreshToken.value = "";
		}

		if (!client) {
			el.status.textContent = "The connection to Stream Deck is not available. Close and reopen this panel.";
			el.status.className = "pi-status pi-status-error";
			for (const b of [el.save, el.clear, el.refresh, el.login]) if (b) b.disabled = true;
			return;
		}

		// Plugin-wide settings: plain selects without a setting binding; the plugin validates.
		function showGlobal(message) {
			if (el.poll && Number.isFinite(message.pollIntervalSeconds)) {
				const value = String(message.pollIntervalSeconds);
				const known = Array.from(el.poll.options || []).some(function (o) {
					return o.value === value;
				});
				if (!known && typeof doc.createElement === "function") {
					const o = doc.createElement("option");
					o.value = value;
					o.textContent = Math.round(message.pollIntervalSeconds / 60 * 10) / 10 + " min";
					el.poll.appendChild(o);
				}
				el.poll.value = value;
			}
			if (el.units && typeof message.unitSystem === "string") el.units.value = message.unitSystem;
		}
		if (el.poll) {
			el.poll.addEventListener("change", function () {
				const seconds = Number(el.poll.value);
				if (Number.isFinite(seconds) && seconds > 0) client.send({ event: EVENTS.setGlobalSettings, pollIntervalSeconds: seconds });
			});
		}
		if (el.units) {
			el.units.addEventListener("change", function () {
				const v = el.units.value;
				if (v === "account" || v === "metric" || v === "imperial") client.send({ event: EVENTS.setGlobalSettings, unitSystem: v });
			});
		}

		let saveTimer = null;
		function setSaving(on) {
			el.save.disabled = on;
			if (saveTimer !== null) timers.clearTimeout(saveTimer);
			saveTimer = on ? timers.setTimeout(function () { setSaving(false); }, SAVE_TIMEOUT_MS) : null;
		}

		// Status: ask once, and say so if nobody answers.
		let statusAnswered = false;
		function askStatus() {
			client.send({ event: EVENTS.getAccountStatus });
		}
		timers.setTimeout(function () {
			if (statusAnswered) return;
			el.status.textContent = "No answer from the plugin. Is it running? Restart Stream Deck if this stays.";
			el.status.className = "pi-status pi-status-error";
		}, PLUGIN_TIMEOUT_MS);

		client.subscribe(function (message) {
			if (!message) return;
			switch (message.event) {
				case "accountStatus": {
					statusAnswered = true;
					showStatus(statusOf(message));
					break;
				}
				case "credentialsResult": {
					statusAnswered = true;
					setSaving(false);
					const status = statusOf(message);
					if (status) showStatus(status);
					if (message.ok) {
						showResult(el.result, "Saved. The fields were cleared and stay on this computer.", false);
					} else if (message.saved === true) {
						// The credentials are stored (the refresh token was already used up), only the
						// first data request failed. Asking for them again would be wrong.
						const why = clip(message.error, MAX_TEXT);
						showResult(
							el.result,
							"Saved, but station data could not be loaded yet" + (why ? ": " + why : "") + ". Polling retries by itself.",
							true,
						);
					} else {
						const why = clip(message.error, MAX_TEXT);
						showResult(el.result, "Not saved" + (why ? ": " + why : ".") + " The fields were cleared; enter the values again.", true);
					}
					break;
				}
				case "browserLogin": {
					if (el.loginBox) el.loginBox.open = true;
					if (typeof message.redirectUri === "string" && el.redirectUri) {
						el.redirectUri.textContent = clip(message.redirectUri, 200);
					}
					const text = clip(message.message, MAX_TEXT);
					if (message.phase === "waiting") {
						showResult(el.loginResult, text || "Waiting for you to sign in in the browser…", false);
					} else if (message.phase === "done") {
						statusAnswered = true;
						const status = statusOf(message);
						if (status) showStatus(status);
						showResult(el.loginResult, text || "Signed in.", false);
					} else {
						showResult(el.loginResult, text || "Browser sign-in failed.", true);
					}
					break;
				}
				case "globalSettings": {
					showGlobal(message);
					break;
				}
				case "getModules":
				case "getMetrics": {
					// Datasource replies carry the status too; a free refresh of the status line.
					const status = statusOf(message);
					if (status) {
						statusAnswered = true;
						showStatus(status);
					}
					break;
				}
				default:
					break;
			}
		});

		el.save.addEventListener("click", function () {
			const built = buildCredentialsMessage({
				clientId: el.clientId && el.clientId.value,
				clientSecret: el.clientSecret && el.clientSecret.value,
				refreshToken: el.refreshToken && el.refreshToken.value,
			});
			if (!built.ok) {
				showResult(el.result, built.error, true);
				return;
			}
			client.send(built.message);
			// Out of the page the moment it has been sent: nothing keeps a copy.
			wipeSecrets();
			setSaving(true);
			showResult(el.result, "Testing the connection…", false);
		});

		// Clearing the stored credentials needs a second click (no confirm dialog in this webview).
		let clearArmed = false;
		let clearTimer = null;
		function disarmClear() {
			clearArmed = false;
			if (clearTimer !== null) timers.clearTimeout(clearTimer);
			clearTimer = null;
			if (el.clear) el.clear.textContent = "Clear";
		}
		if (el.clear) {
			el.clear.addEventListener("click", function () {
				if (!clearArmed) {
					clearArmed = true;
					el.clear.textContent = "Click again to clear";
					clearTimer = timers.setTimeout(disarmClear, CLEAR_ARM_MS);
					return;
				}
				disarmClear();
				wipeSecrets();
				client.send({ event: EVENTS.clearCredentials });
				showResult(el.result, "Stored credentials removed.", false);
				timers.setTimeout(askStatus, 500);
			});
		}

		if (el.refresh) {
			el.refresh.addEventListener("click", function () {
				client.send({ event: EVENTS.refreshNow });
				showResult(el.result, "Refresh requested. The plugin limits how often it asks the service.", false);
				timers.setTimeout(askStatus, 2000);
			});
		}

		if (el.login) {
			el.login.addEventListener("click", function () {
				const built = buildBrowserLoginMessage({
					clientId: el.clientId && el.clientId.value,
					clientSecret: el.clientSecret && el.clientSecret.value,
				});
				if (!built.ok) {
					showResult(el.loginResult, built.error, true);
					return;
				}
				client.send(built.message);
				// The secret goes at once; the id is not secret and stays for a second try
				// after the redirect address has been registered.
				if (el.clientSecret) el.clientSecret.value = "";
				showResult(el.loginResult, "Starting the browser sign-in…", false);
			});
		}

		askStatus();
		client.send({ event: EVENTS.getGlobalSettings });
	}

	/* ------------------------------------------------------------------ */
	/* Module picker                                                       */
	/* ------------------------------------------------------------------ */

	/**
	 * Module dropdown with a manual escape hatch.
	 *
	 * The escape hatch is a plain text field bound to the same `moduleKey` setting; it must
	 * not depend on the plugin answering (an escape hatch cannot depend on the thing it is
	 * an escape hatch from). It appears on request, when the plugin does not answer, and
	 * when the answer has no usable entry.
	 *
	 * When the module changes, the metric dropdown (if the page has one) is asked to
	 * refresh, because the choice of metrics depends on the module type.
	 */
	function initModulePicker(env) {
		const e = env || defaultEnv();
		const doc = e.doc;
		const timers = e.timers;
		const client = e.client;
		const moduleSelect = doc.querySelector('[setting="moduleKey"][datasource]');
		const manualItem = doc.getElementById("manualModuleItem");
		const manualField = doc.getElementById("manualModuleKey");
		const manualBtn = doc.getElementById("manualModuleBtn");
		const manualHint = doc.getElementById("manualModuleHint");
		const listHint = doc.getElementById("moduleListHint");
		const metricSelect = doc.querySelector('[setting="metric"]');

		function showManual() {
			if (manualItem) manualItem.style.display = "";
		}

		if (manualBtn) {
			manualBtn.addEventListener("click", function () {
				showManual();
				if (manualField && typeof manualField.focus === "function") manualField.focus();
			});
		}

		if (manualField && manualHint) {
			const check = function () {
				const parsed = parseModuleKey(manualField.value);
				manualHint.textContent = parsed.valid ? "" : "Use the station id, a vertical bar, then the module id.";
				manualHint.className = parsed.valid ? "pi-hint pi-hidden" : "pi-warn";
			};
			manualField.addEventListener("input", check);
			manualField.addEventListener("valuechange", check);
		}

		if (moduleSelect && metricSelect) {
			let refreshTimer = null;
			moduleSelect.addEventListener("valuechange", function () {
				// The plugin reads the stored module when it answers; give sdpi time to write it.
				if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
				refreshTimer = timers.setTimeout(function () {
					if (typeof metricSelect.refresh === "function") metricSelect.refresh();
				}, 400);
			});
		}

		// A metric reply may name a default; preselect it while the setting is still unset.
		if (client && metricSelect) {
			client.subscribe(function (message) {
				if (!message || message.event !== "getMetrics") return;
				const def = pickDefault(message);
				if (def === "" || metricSelect.value) return;
				if (typeof metricSelect.setAttribute === "function") metricSelect.setAttribute("default", def);
				metricSelect.default = def;
			});
		}

		if (!listHint) return;
		let answered = false;
		timers.setTimeout(function () {
			if (answered) return;
			listHint.textContent = "No module list from the plugin. Is it running? Enter the module by hand below.";
			listHint.className = "pi-warn";
			showManual();
		}, PLUGIN_TIMEOUT_MS);

		if (client) {
			client.subscribe(function (message) {
				if (!message || message.event !== "getModules") return;
				answered = true;
				const d = describeDatasourceReply(message);
				if (d.kind === "ok") {
					listHint.textContent = "";
					listHint.className = "pi-hint pi-hidden";
				} else {
					listHint.textContent = d.text;
					listHint.className = "pi-warn";
					showManual();
				}
			});
		}
	}

	/** The reply's optional `defaultValue`, only when it is a non-empty string; else "". */
	function pickDefault(message) {
		return message && typeof message.defaultValue === "string" ? message.defaultValue : "";
	}

	/**
	 * Hide the module and metric selects (element #pinnedBlock) while "Follow focus" is
	 * ticked. An unset checkbox counts as ticked (the page declares default="true").
	 * sdpi writes the stored value a moment after load, so the state is applied again then.
	 */
	function initFollowToggle(env) {
		const e = env || defaultEnv();
		const box = e.doc.querySelector('[setting="followFocus"]');
		const block = e.doc.getElementById("pinnedBlock");
		if (!box || !block) return;
		const apply = function () {
			const v = box.value;
			const follow = !(v === false || v === "false");
			block.style.display = follow ? "none" : "";
		};
		apply();
		box.addEventListener("valuechange", apply);
		box.addEventListener("change", apply);
		e.timers.setTimeout(apply, 500);
		e.timers.setTimeout(apply, 2000);
	}

	/**
	 * Alert thresholds apply to a fixed metric only. While "Follow focus" is ticked, hide the
	 * threshold fields (#alertBlock) and show the hint (#alertFollowHint). Unlike the dial and
	 * history pages, this page's checkbox is unticked when unset, so only an explicit true follows.
	 */
	function initAlertToggle(env) {
		const e = env || defaultEnv();
		const box = e.doc.querySelector('[setting="followFocus"]');
		const block = e.doc.getElementById("alertBlock");
		const hint = e.doc.getElementById("alertFollowHint");
		if (!box || !block) return;
		const apply = function () {
			const v = box.value;
			const follow = v === true || v === "true";
			block.style.display = follow ? "none" : "";
			if (hint) {
				if (follow) hint.classList.remove("pi-hidden");
				else hint.classList.add("pi-hidden");
			}
		};
		apply();
		box.addEventListener("valuechange", apply);
		box.addEventListener("change", apply);
		e.timers.setTimeout(apply, 500);
		e.timers.setTimeout(apply, 2000);
	}

	window.HomeWeatherPI = {
		EVENTS: EVENTS,
		describeStatus: describeStatus,
		buildCredentialsMessage: buildCredentialsMessage,
		buildBrowserLoginMessage: buildBrowserLoginMessage,
		parseModuleKey: parseModuleKey,
		countSelectable: countSelectable,
		describeDatasourceReply: describeDatasourceReply,
		payloadOf: payloadOf,
		statusOf: statusOf,
		initAccount: initAccount,
		initModulePicker: initModulePicker,
		initFollowToggle: initFollowToggle,
		initAlertToggle: initAlertToggle,
		pickDefault: pickDefault,
	};
})();

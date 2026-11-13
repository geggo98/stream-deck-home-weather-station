import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NetatmoError } from "../src/adapter/station/errors.ts";
import {
	MAX_MODULES_PER_STATION,
	MAX_STATIONS,
	cleanText,
	parsePreferences,
	parseStationsResponse,
} from "../src/adapter/station/parse.ts";
import { T0, fixture } from "./station-helpers.ts";

describe("parseStationsResponse (full fixture)", () => {
	const snap = parseStationsResponse(fixture("stations-full"), T0);
	const station = snap.stations[0]!;

	it("maps stations, roles and order (base first)", () => {
		assert.equal(snap.fetchedAt, T0);
		assert.equal(snap.stations.length, 1);
		assert.equal(station.name, "Test Home");
		assert.deepEqual(
			station.modules.map((m) => [m.type, m.role, m.name]),
			[
				["NAMain", "base", "Living room"],
				["NAModule1", "outdoor", "Garden"],
				["NAModule2", "wind", "Anemometer"],
				["NAModule3", "rain", "Rain gauge"],
				["NAModule4", "indoor-extra", "Bedroom"],
			],
		);
		assert.equal(station.id, station.modules[0]!.id);
	});

	it("maps measurements to metric keys, keeping Pressure and AbsolutePressure apart", () => {
		const base = station.modules[0]!;
		assert.deepEqual(base.values, {
			temperature: 21.4,
			co2: 612,
			humidity: 45,
			noise: 38,
			pressure: 1013.2,
			absolutePressure: 998.7,
			tempMin: 19.8,
			tempMax: 22.1,
			tempTrend: 0,
			pressureTrend: 1,
		});
		assert.deepEqual(station.modules[2]!.values, { windStrength: 14, windAngle: 250, gustStrength: 27, gustAngle: 262 });
		assert.deepEqual(station.modules[3]!.values, { rain: 0.3, rain1h: 0.5, rain24h: 4.2 });
		assert.equal(station.modules[1]!.values.tempTrend, -1);
	});

	it("derives measuredAt from time_utc in milliseconds and keeps battery", () => {
		assert.equal(station.modules[0]!.measuredAt, 1_700_000_000_000);
		assert.equal(station.modules[1]!.measuredAt, 1_699_999_990_000);
		assert.equal(station.modules[1]!.batteryPercent, 87);
		assert.equal(station.modules[0]!.batteryPercent, undefined);
	});

	it("reads unit preferences and a canonical locale", () => {
		assert.deepEqual(snap.preferences, { unitSystem: "metric", windUnit: "kmh", pressureUnit: "mbar", locale: "en-GB" });
	});
});

describe("parseStationsResponse (partial fixture)", () => {
	const snap = parseStationsResponse(fixture("stations-partial"), T0);
	const station = snap.stations[0]!;

	it("tolerates modules without dashboard_data and skips unknown types", () => {
		assert.equal(station.modules.length, 2);
		const terrace = station.modules[1]!;
		assert.equal(terrace.reachable, false);
		assert.equal(terrace.measuredAt, null);
		assert.deepEqual(terrace.values, {});
		assert.equal(terrace.batteryPercent, 12);
	});

	it("falls back to station_name when home_name is absent", () => {
		assert.equal(station.name, "Test Station");
	});

	it("reads imperial preferences, beaufort, inHg and underscore locales", () => {
		assert.deepEqual(snap.preferences, { unitSystem: "imperial", windUnit: "beaufort", pressureUnit: "inhg", locale: "de-DE" });
	});
});

describe("parseStationsResponse (edge cases)", () => {
	it("empty device list gives an empty snapshot, not an error", () => {
		const snap = parseStationsResponse(fixture("stations-empty"), T0);
		assert.equal(snap.stations.length, 0);
	});

	it("a missing body is a protocol error", () => {
		for (const bad of [null, [], {}, { body: null }, { body: [] }, "x", 5]) {
			assert.throws(() => parseStationsResponse(bad, T0), (e: unknown) => e instanceof NetatmoError && e.kind === "protocol");
		}
	});

	it("drops non-finite, mistyped and implausible numbers", () => {
		const raw = fixture("stations-full");
		const dash = raw.body.devices[0].dashboard_data;
		dash.Temperature = "21.4";
		dash.Humidity = 140;
		dash.CO2 = null;
		dash.Noise = Number.NaN; // not representable in JSON, but a parsed object may carry it
		dash.Pressure = -5;
		dash.temp_trend = "sideways";
		const values = parseStationsResponse(raw, T0).stations[0]!.modules[0]!.values;
		for (const k of ["temperature", "humidity", "co2", "noise", "pressure", "tempTrend"] as const) assert.equal(values[k], undefined, k);
		assert.equal(values.absolutePressure, 998.7);
	});

	it("normalises a 360 degree angle to 0 (wind and gust angle only)", () => {
		const raw = fixture("stations-full");
		const wind = raw.body.devices[0].modules.find((m: { type: string }) => m.type === "NAModule2");
		wind.dashboard_data.WindAngle = 360;
		wind.dashboard_data.GustAngle = 360;
		const values = parseStationsResponse(raw, T0).stations[0]!.modules.find((m) => m.role === "wind")!.values;
		assert.equal(values.windAngle, 0);
		assert.equal(values.gustAngle, 0);
	});

	// Before the fix the 360 -> 0 rule sat in the generic loop and turned a valid reading of exactly 360 into 0.
	it("a reading of exactly 360 is kept for every metric that is not an angle (CO2 360 ppm, rain 360 mm, pressure 360 mbar, wind 360 km/h)", () => {
		const raw = fixture("stations-full");
		const device = raw.body.devices[0];
		Object.assign(device.dashboard_data, { CO2: 360, Pressure: 360, AbsolutePressure: 360, Noise: 120 });
		const rain = device.modules.find((m: { type: string }) => m.type === "NAModule3");
		Object.assign(rain.dashboard_data, { Rain: 360, sum_rain_1: 360, sum_rain_24: 360 });
		const wind = device.modules.find((m: { type: string }) => m.type === "NAModule2");
		Object.assign(wind.dashboard_data, { WindStrength: 360, GustStrength: 360 });
		const modules = parseStationsResponse(raw, T0).stations[0]!.modules;
		const base = modules.find((m) => m.role === "base")!.values;
		assert.equal(base.co2, 360);
		assert.equal(base.pressure, 360);
		assert.equal(base.absolutePressure, 360);
		const rainValues = modules.find((m) => m.role === "rain")!.values;
		assert.deepEqual([rainValues.rain, rainValues.rain1h, rainValues.rain24h], [360, 360, 360]);
		const windValues = modules.find((m) => m.role === "wind")!.values;
		assert.deepEqual([windValues.windStrength, windValues.gustStrength], [360, 360]);
	});

	it("enforces the station and module bounds", () => {
		const raw = fixture("stations-full");
		const device = raw.body.devices[0];
		const many = (n: number, prefix: number) =>
			Array.from({ length: n }, (_, i) => ({ ...structuredClone(device), _id: `00:00:5e:00:${prefix.toString(16).padStart(2, "0")}:${i.toString(16).padStart(2, "0")}` }));
		raw.body.devices = many(MAX_STATIONS + 5, 1);
		raw.body.devices[0].modules = Array.from({ length: MAX_MODULES_PER_STATION + 10 }, (_, i) => ({
			_id: `00:00:5e:00:99:${i.toString(16).padStart(2, "0")}`,
			type: "NAModule1",
			module_name: "m",
		}));
		const warnings: string[] = [];
		const snap = parseStationsResponse(raw, T0, { warn: (m) => warnings.push(m) });
		assert.equal(snap.stations.length, MAX_STATIONS);
		assert.equal(snap.stations[0]!.modules.length, 1 + MAX_MODULES_PER_STATION);
		assert.ok(warnings.some((w) => w.includes("above the limit")));
	});

	it("deduplicates module ids and strips whitespace inside ids", () => {
		const raw = fixture("stations-full");
		const mods = raw.body.devices[0].modules;
		mods[1]._id = mods[0]._id;
		mods[0]._id = " 00:00:5e:00:53:02 ";
		const ids = parseStationsResponse(raw, T0).stations[0]!.modules.map((m) => m.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.ok(ids.includes("00:00:5e:00:53:02"));
	});

	it("truncates and cleans names, including control characters", () => {
		const raw = fixture("stations-full");
		raw.body.devices[0].home_name = `Bad\u001b[31m${"x".repeat(200)}`;
		const name = parseStationsResponse(raw, T0).stations[0]!.name;
		assert.ok(name.length <= 64);
		assert.ok(!name.includes("\u001b"));
		assert.equal(cleanText("   "), undefined);
	});

	it("never copies account e-mail, coordinates or home ids into the snapshot", () => {
		const raw = fixture("stations-full");
		const mail = ["someone", "@", "mail.invalid"].join("");
		raw.body.user.mail = mail;
		raw.body.devices[0].home_id = "home-id-marker-0001";
		raw.body.devices[0].place = { location: [1.5, 2.5], altitude: 1234567, timezone: "Etc/Marker", country: "ZZ" };
		const text = JSON.stringify(parseStationsResponse(raw, T0));
		for (const marker of [mail, "home-id-marker-0001", "1234567", "Etc/Marker"]) assert.ok(!text.includes(marker), marker);
	});

	it("accepts only the documented wind/pressure/unit enumerations", () => {
		assert.deepEqual(parsePreferences({ administrative: { unit: 7, windunit: 9, pressureunit: -1, lang: "<script>" } }), {
			unitSystem: "metric",
			windUnit: "kmh",
			pressureUnit: "mbar",
		});
		assert.deepEqual(parsePreferences(undefined), { unitSystem: "metric", windUnit: "kmh", pressureUnit: "mbar" });
		assert.equal(parsePreferences({ administrative: { unit: 1 } }).windUnit, "mph");
		assert.equal(parsePreferences({ administrative: { lang: "fr-FR" } }).locale, "fr-FR");
		assert.equal(parsePreferences({ administrative: { lang: "fr-FR", reg_locale: "de_CH" } }).locale, "de-CH");
	});
});

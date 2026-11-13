import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseStationsResponse } from "../src/adapter/station/parse.ts";
import { BASE_TIME_SECONDS, anonymise, verifyNoLeak } from "../scripts/capture-fixture.ts";
import { makeTempDir } from "./station-helpers.ts";

/**
 * A synthetic input that LOOKS like a real capture. Every identifying value is assembled at
 * runtime so that no such literal (MAC address, e-mail address, coordinate pair) is written
 * into the repository; all of it is invented.
 */
function realLookingCapture() {
	const hex = (n: number) => n.toString(16).padStart(2, "0");
	const mac = (n: number) => ["70", "ee", "50", hex(0x21 + n), hex(0xa0 + n), hex(0x5c - n)].join(":");
	const mail = ["erika", ".", "musterfrau", "@", "mail", ".", "example"].join("");
	const lat = 40 + 0.5125;
	const lon = 8 + 0.7391;
	const homeId = ["5f", "0a", "9c", "11", "e2", "d4", "30", "7b", "81", "26", "cc", "04"].join("");
	const now = 1_760_000_000;
	return {
		originals: { mac0: mac(0), mac1: mac(1), mac2: mac(2), mail, homeId, name: "Haus Muster", station: "Muster Wetterstation", garden: "Gartenhaus", city: "Musterstadt", lat, lon, short: "Max" },
		raw: {
			status: "ok",
			time_exec: 0.0719,
			time_server: now + 30,
			body: {
				devices: [
					{
						_id: mac(0),
						station_name: "Muster Wetterstation",
						home_id: homeId,
						home_name: "Haus Muster",
						module_name: "Max",
						type: "NAMain",
						firmware: 192,
						wifi_status: 48,
						reachable: true,
						co2_calibrating: false,
						place: { altitude: 311, city: "Musterstadt", country: "DE", timezone: "Europe/Berlin", location: [lon, lat] },
						data_type: ["Temperature", "CO2", "Humidity", "Noise", "Pressure"],
						dashboard_data: { time_utc: now, Temperature: 22.1, CO2: 705, Humidity: 41, Noise: 33, Pressure: 1011.8, AbsolutePressure: 975.4, min_temp: 20.3, max_temp: 22.9, date_min_temp: now - 30000, date_max_temp: now - 5000, temp_trend: "up", pressure_trend: "stable", unexpected_new_field: "Gartenhaus" },
						modules: [
							{ _id: mac(1), type: "NAModule1", module_name: "Gartenhaus", last_setup: now - 9_000_000, data_type: ["Temperature", "Humidity"], battery_percent: 77, battery_vp: 5400, firmware: 51, last_message: now - 60, last_seen: now - 60, rf_status: 64, reachable: true, dashboard_data: { time_utc: now - 100, Temperature: 8.4, Humidity: 88, min_temp: 5.1, max_temp: 9.0, date_min_temp: now - 20000, date_max_temp: now - 3000, temp_trend: "down" } },
							{ _id: mac(2), type: "NAModule3", module_name: "Regen", battery_percent: 90, rf_status: 70, reachable: true, dashboard_data: { time_utc: now - 200, Rain: 0, sum_rain_1: 0.2, sum_rain_24: 3.1 } },
						],
					},
				],
				user: { mail, administrative: { country: "DE", reg_locale: "de-DE", lang: "de-DE", unit: 0, windunit: 0, pressureunit: 0, feel_like_algo: 0 } },
			},
		},
	};
}

describe("capture-fixture: anonymise", () => {
	const { raw, originals } = realLookingCapture();
	const result = anonymise(raw);
	const text = JSON.stringify(result.output);

	it("produces a fixture the parser accepts, with the same structure", () => {
		const snap = parseStationsResponse(result.output, 1);
		assert.equal(snap.stations.length, 1);
		assert.deepEqual(snap.stations[0]!.modules.map((m) => m.type), ["NAMain", "NAModule1", "NAModule3"]);
		assert.equal(snap.stations[0]!.modules[0]!.values.temperature, 22.1);
		assert.equal(snap.stations[0]!.modules[0]!.values.tempTrend, 1);
		assert.equal(snap.preferences.unitSystem, "metric");
		assert.equal(result.stations, 1);
		assert.equal(result.modules, 3);
	});

	it("uses documentation-range MACs, generic names, a fixed time base, and keeps bridge links", () => {
		const snap = parseStationsResponse(result.output, 1);
		const [base, outdoor, rain] = snap.stations[0]!.modules;
		assert.deepEqual([base!.id, outdoor!.id, rain!.id], ["00:00:5e:00:53:01", "00:00:5e:00:53:02", "00:00:5e:00:53:03"]);
		assert.equal(snap.stations[0]!.name, "Test Home 1");
		assert.equal(base!.measuredAt, BASE_TIME_SECONDS * 1000);
		assert.equal(outdoor!.measuredAt, (BASE_TIME_SECONDS - 100) * 1000, "relative ages are preserved");
		const out = result.output as { body: { devices: Array<{ modules: Array<{ bridge?: string }> }> } };
		assert.equal(out.body.devices[0]!.modules[0]!.bridge, "00:00:5e:00:53:01");
	});

	it("drops location, timezone, city, country, mail, home ids and unknown fields", () => {
		for (const needle of ["place", "timezone", "city", "country", "mail", "home_id", "station_name", "unexpected_new_field", "location"]) {
			assert.ok(!text.includes(`"${needle}"`), needle);
		}
	});

	it("none of the original identifiers survive anywhere (checked independently of verifyNoLeak)", () => {
		const lower = text.toLowerCase();
		for (const [key, value] of Object.entries(originals)) {
			if (key === "lat" || key === "lon") {
				assert.ok(!text.includes(String(value)), key);
			} else if (key === "short") {
				assert.ok(!JSON.parse(text).body.devices.some((d: { module_name: string }) => d.module_name === value));
			} else {
				assert.ok(!lower.includes(String(value).toLowerCase()), key);
				assert.ok(!lower.includes(String(value).toLowerCase().replace(/:/g, "")), `${key} without colons`);
			}
		}
		assert.deepEqual(verifyNoLeak(result), []);
	});
});

describe("capture-fixture: the verification really can fail", () => {
	const make = () => {
		const { raw } = realLookingCapture();
		return anonymise(raw);
	};

	it("catches a surviving long original, a short original, a foreign MAC, an e-mail and a 24-hex id", () => {
		const r = make();
		const withExtra = (patch: (o: any) => void) => {
			const out = structuredClone(r.output) as any;
			patch(out);
			return verifyNoLeak({ ...r, output: out });
		};
		assert.ok(withExtra((o) => (o.body.devices[0].home_name = "Haus Muster")).length > 0, "long original");
		assert.ok(withExtra((o) => (o.body.devices[0].module_name = "Max")).length > 0, "short original (whole-value match)");
		assert.ok(withExtra((o) => (o.body.devices[0]._id = ["70", "ee", "50", "00", "00", "01"].join(":"))).length > 0, "foreign MAC");
		assert.ok(withExtra((o) => (o.body.devices[0].module_name = ["a", "@", "b.example"].join(""))).length > 0, "e-mail");
		assert.ok(withExtra((o) => (o.body.devices[0].module_name = "5f0a9c11".concat("e2d4307b", "8126cc04"))).length > 0, "24-hex id");
		assert.ok(withExtra((o) => (o.body.devices[0].module_name = "192.0.2.1")).length > 0, "IPv4");
	});

	it("the unmodified output verifies clean and the scan really examined strings", () => {
		const r = make();
		assert.deepEqual(verifyNoLeak(r), []);
		assert.ok(r.originalStrings.length >= 10, "the scan must see the input's strings (a structurally blind scan proves nothing)");
		assert.ok(r.originalNumbers.length === 2, "both coordinates were collected");
	});

	it("a coordinate that does survive is detected", () => {
		const r = make();
		const lonText = String(r.originalNumbers[0]);
		const out = structuredClone(r.output) as any;
		out.body.devices[0].leak = Number(lonText);
		assert.ok(verifyNoLeak({ ...r, output: out }).some((p) => p.includes("location number")));
	});

	it("rejects input that is not a getstationsdata response", () => {
		assert.throws(() => anonymise({ nope: 1 }), /no body object/);
		assert.throws(() => anonymise(null), /no body object/);
	});
});

describe("capture-fixture: command line", () => {
	const script = path.join(import.meta.dirname, "..", "scripts", "capture-fixture.ts");

	it("writes a fixture, refuses to overwrite without --force, and verifies", async (t) => {
		const dir = await makeTempDir(t);
		const input = path.join(dir, "raw.json");
		const out = path.join(dir, "out");
		fs.writeFileSync(input, JSON.stringify(realLookingCapture().raw));
		const run = (...extra: string[]) => spawnSync(process.execPath, [script, input, "--name", "unit-test", "--out-dir", out, ...extra], { encoding: "utf8" });
		const first = run();
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.stderr, /none survive/);
		const written = fs.readFileSync(path.join(out, "unit-test.json"), "utf8");
		assert.ok(!/Muster|Gartenhaus|70:ee:50/i.test(written));
		assert.equal(run().status, 1);
		assert.equal(run("--force").status, 0);
		assert.equal(spawnSync(process.execPath, [script, input, "--name", "Bad Name", "--out-dir", out], { encoding: "utf8" }).status, 1);
		assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 1);
	});
});

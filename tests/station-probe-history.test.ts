import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main, summariseMeasure } from "../scripts/probe-api.ts";
import { fixture, sendJson, startApiDouble, stationsOk, tokenIssuer } from "./station-helpers.ts";

const DAY = 24 * 3_600_000;

describe("probe --history: structural summary of getmeasure", () => {
	it("describes the optimised shape without printing values or timestamps", () => {
		const lines = summariseMeasure(fixture("measure-optimised"), "optimised", DAY);
		const text = lines.join("\n");
		assert.ok(lines.length >= 3, "the scan must see real output");
		assert.match(text, /shape = optimised \(array\), chunks=2, rows=6, step_time per chunk: 1800 s/);
		assert.match(text, /null holes: 1; value range class: within -40\.\.60/);
		assert.match(text, /parser: 5 point\(s\), step 1800 s, covers about 10% of the window/);
		for (const forbidden of ["9.8", "11.3", "1699988200", "10.4"]) assert.ok(!text.includes(forbidden), forbidden);
	});

	it("prints observed first/last timestamps relative to the request (bucket start vs middle, local vs UTC)", () => {
		// fixture points: 1699988200 .. 1699999000 (the optimised and plain series); request 1699913700 .. 1700000100, scale 1800 s
		const req = { beginS: 1_699_913_700, endS: 1_700_000_100, scaleS: 1800 };
		const text = summariseMeasure(fixture("measure-optimised"), "optimised", DAY, req).join("\n");
		assert.match(text, /first timestamp: date_begin \+74500 s, \(t - date_begin\) mod scale = 700 s/);
		assert.match(text, /last timestamp: date_end -1100 s, \(t - date_begin\) mod scale = 700 s/);
		assert.match(text, /mod scale 0 = bucket start, scale\/2 \(900 s\) = bucket middle/);
		assert.ok(!text.includes("1699988200"));
		assert.ok(!summariseMeasure(fixture("measure-optimised"), "optimised", DAY).join("\n").includes("first timestamp"), "no request, no relative line");
	});

	it("describes the plain shape", () => {
		const text = summariseMeasure(fixture("measure-plain"), "plain", DAY).join("\n");
		assert.match(text, /shape = plain \(object keyed by epoch seconds\), rows=5/);
		assert.match(text, /parser: 5 point\(s\), step 1800 s/);
	});

	it("flags a suspicious value range and a rejected body", () => {
		const hot = { status: "ok", body: [{ beg_time: 1_700_000_000, step_time: 1800, value: [[75], [80]] }] };
		assert.match(summariseMeasure(hot, "x", DAY).join("\n"), /CHECK: degrees Fahrenheit/);
		const broken = { status: "ok", body: [{ beg_time: "x" }] };
		assert.match(summariseMeasure(broken, "x", DAY).join("\n"), /parser REJECTED/);
		assert.match(summariseMeasure({ status: "error", body: [] }, "x", DAY).join("\n"), /envelope rejected/);
		assert.match(summariseMeasure({ status: "ok", body: 3 }, "x", DAY).join("\n"), /neither array nor object/);
	});
});

describe("probe --history: main against a local double", () => {
	const env = { NETATMO_CLIENT_ID: "id-0001", NETATMO_CLIENT_SECRET: "secret-0001", NETATMO_REFRESH_TOKEN: "seed-refresh-0001" };

	async function capture(run: () => Promise<number>): Promise<{ code: number; text: string }> {
		const out: string[] = [];
		const origLog = console.log;
		const origErr = console.error;
		console.log = (...a: unknown[]) => void out.push(a.join(" "));
		console.error = (...a: unknown[]) => void out.push(a.join(" "));
		try {
			return { code: await run(), text: out.join("\n") };
		} finally {
			console.log = origLog;
			console.error = origErr;
		}
	}

	it("requests 24 h of temperature for the first base module, twice (optimised and plain), and prints structure only", async (t) => {
		const api = await startApiDouble(t);
		api.route("POST /oauth2/token", tokenIssuer());
		api.route("GET /api/getstationsdata", stationsOk());
		api.route("GET /api/getmeasure", (req, res) => sendJson(res, 200, fixture(req.url.includes("optimize=true") ? "measure-optimised" : "measure-plain")));
		const r = await capture(() => main(["--no-post-check", "--history"], env, { baseUrl: api.baseUrl, runSecretspec: () => ({ ok: true }) }));
		assert.equal(r.code, 0, r.text);
		const sent = api.requestsTo("GET /api/getmeasure");
		assert.equal(sent.length, 2);
		for (const req of sent) {
			assert.match(req.url, /^\/api\/getmeasure\?device_id=00%3A00%3A5e%3A00%3A53%3A01&scale=30min&type=temperature&date_begin=\d+&date_end=\d+&optimize=(true|false)&real_time=false$/);
			assert.ok(!req.url.includes("module_id"), "the base module is addressed by device_id alone");
		}
		assert.match(sent[0]!.url, /optimize=true/);
		assert.match(sent[1]!.url, /optimize=false/);
		assert.match(r.text, /shape = optimised/);
		assert.match(r.text, /shape = plain/);
		for (const forbidden of ["00:00:5e", "9.8", "1699988200", "fake-access", "secret-0001"]) assert.ok(!r.text.includes(forbidden), forbidden);
	});

	it("without --history no getmeasure request is made", async (t) => {
		const api = await startApiDouble(t);
		api.route("POST /oauth2/token", tokenIssuer());
		api.route("GET /api/getstationsdata", stationsOk());
		const r = await capture(() => main(["--no-post-check"], env, { baseUrl: api.baseUrl, runSecretspec: () => ({ ok: true }) }));
		assert.equal(r.code, 0, r.text);
		assert.equal(api.requestsTo("GET /api/getmeasure").length, 0);
	});

	it("a failing history request is reported, not fatal", async (t) => {
		const api = await startApiDouble(t);
		api.route("POST /oauth2/token", tokenIssuer());
		api.route("GET /api/getstationsdata", stationsOk());
		api.route("GET /api/getmeasure", (_req, res) => sendJson(res, 503, {}));
		const r = await capture(() => main(["--no-post-check", "--history"], env, { baseUrl: api.baseUrl, runSecretspec: () => ({ ok: true }) }));
		assert.equal(r.code, 0, r.text);
		assert.match(r.text, /getmeasure \(optimize=true\): failed \(transient HTTP 503\)/);
	});
});

/** The sparkline renderer: shapes only, gaps as gaps, bars for rain, quantised coordinates. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { composeSparkline, type SparklineSpec } from "../src/render/sparkline.ts";

const STEP = 30 * 60_000;
const END = 1_800_000_000_000 - (1_800_000_000_000 % STEP);
const START = END - 24 * 3_600_000;

function spec(points: Array<{ t: number; v: number }>, extra: Partial<SparklineSpec> = {}): SparklineSpec {
	return { points, stepMs: STEP, windowStart: START, windowEnd: END, accent: "#4FB3F6", ...extra };
}
const series = (n: number, v: (i: number) => number, from = 0) => Array.from({ length: n }, (_, i) => ({ t: START + (from + i) * STEP, v: v(from + i) }));
const pathsOf = (svg: string) => [...svg.matchAll(/<path d="(M[^"]+)" fill="none" stroke="#/g)].map((m) => m[1]!);

describe("composeSparkline", () => {
	it("draws one connected line for a complete series, with a marker on the newest point", () => {
		const svg = composeSparkline(spec(series(48, (i) => Math.sin(i / 6) * 5 + 10)));
		assert.match(svg, /^<svg [^>]*width="144" height="144"/);
		assert.equal(pathsOf(svg).length, 1);
		assert.equal(pathsOf(svg)[0]!.split("L").length > 20, true);
		assert.equal(svg.includes("<text"), false, "no text: labels go through the native title");
		assert.match(svg, /<circle [^>]*r="4"/);
	});

	it("draws gaps as gaps: no line across more than two buckets, one across a single missing bucket", () => {
		const gap = [...series(10, (i) => i), ...series(10, (i) => i, 20)]; // buckets 10..19 missing
		const withGap = composeSparkline(spec(gap));
		assert.equal(pathsOf(withGap)[0]!.split("M").length - 1, 2, "two separate runs");
		const oneMissing = composeSparkline(spec([...series(5, (i) => i), ...series(5, (i) => i, 6)]));
		assert.equal(pathsOf(oneMissing)[0]!.split("M").length - 1, 1, "one missing bucket is bridged");
	});

	it("a lone point is a dot, a flat series a horizontal line, nothing at all is an empty chart", () => {
		const dot = composeSparkline(spec([{ t: END - STEP, v: 3 }]));
		assert.equal(pathsOf(dot).length, 0);
		assert.match(dot, /<circle/);
		const flat = composeSparkline(spec(series(20, () => 7)));
		const ys = new Set([...pathsOf(flat)[0]!.matchAll(/ (\d+)/g)].map((m) => m[1]));
		assert.equal(ys.size, 1, "all points on one y");
		const empty = composeSparkline(spec([]));
		assert.equal(/<circle|stroke="#4FB3F6"/.test(empty), false);
		assert.match(empty, /<\/svg>$/);
	});

	it("draws rain as bars on a baseline, and no bar for a dry bucket", () => {
		const rain = [0, 0, 1.2, 0.4, 0, 3.6, 0].map((v, i) => ({ t: START + (30 + i) * STEP, v }));
		const svg = composeSparkline(spec(rain, { bars: true }));
		assert.equal((svg.match(/<rect x=/g) ?? []).length, 3, "three wet buckets");
		assert.equal(pathsOf(svg).length, 0, "no line");
		const heights = [...svg.matchAll(/<rect x="\d+" y="\d+" width="\d+" height="(\d+)"/g)].map((m) => Number(m[1]));
		assert.ok(heights[2]! > heights[0]! && heights[0]! > heights[1]!, `bar heights follow the values: ${heights}`);
		assert.equal(/<rect x=/.test(composeSparkline(spec(series(5, () => 0), { bars: true }))), false);
	});

	it("is quantised: a nudge of the data by a fraction of a pixel gives the same image", () => {
		const a = composeSparkline(spec(series(48, (i) => 10 + (i % 5))));
		const b = composeSparkline(spec(series(48, (i) => 10 + (i % 5) + 0.001)));
		assert.equal(a, b);
		assert.equal(/\d\.\d/.test(a.replace(/<svg[^>]*>/, "")), false, "no fractional coordinates");
	});

	it("is safe with junk: NaN, infinities, unsorted and out-of-window points, a hostile accent", () => {
		const points = [
			{ t: END - STEP, v: Number.NaN },
			{ t: Number.NaN, v: 1 },
			{ t: END - 3 * STEP, v: 4 },
			{ t: END - 5 * STEP, v: Number.POSITIVE_INFINITY },
			{ t: END - 4 * STEP, v: 2 },
			{ t: START - 100 * STEP, v: 9 },
			{ t: END + 100 * STEP, v: 9 },
		];
		const svg = composeSparkline(spec(points, { accent: '"><script>x</script>' }));
		assert.equal(/NaN|Infinity|script/.test(svg), false);
		assert.equal(pathsOf(svg).length, 1);
		assert.equal(composeSparkline(spec(series(3, (i) => i), { windowEnd: START })).includes("<circle"), false, "an empty window draws nothing");
	});

	it("dims the line on stale data and supports a bare strip", () => {
		const bright = composeSparkline(spec(series(10, (i) => i)));
		const dim = composeSparkline(spec(series(10, (i) => i), { dim: true }));
		assert.notEqual(bright, dim);
		const strip = composeSparkline(spec(series(10, (i) => i), { size: { width: 184, height: 52, tile: false } }));
		assert.match(strip, /width="184" height="52"/);
		assert.equal(strip.includes("rx=\"18\""), false, "no tile background on a strip");
	});
});

describe("composeSparkline bucketAnchor", () => {
	const xs = (svg: string) => [...svg.matchAll(/[ML](\d+) \d+/g)].map((m) => Number(m[1]));

	it("defaults to the middle: t is drawn where it is; start shifts a line by half a bucket", () => {
		const points = series(48, (i) => i);
		const middle = composeSparkline(spec(points));
		assert.equal(composeSparkline(spec(points, { bucketAnchor: "middle" })), middle);
		const start = composeSparkline(spec(points, { bucketAnchor: "start" }));
		assert.notEqual(start, middle);
		const dx = xs(pathsOf(start)[0]!)[0]! - xs(pathsOf(middle)[0]!)[0]!;
		assert.ok(dx >= 1 && dx <= 2, `half a bucket is 1.25 px of the 120 px box, got ${dx}`);
	});

	it("bars span the bucket: with the middle anchor they begin half a bucket before t", () => {
		const bar = [{ t: START + 10 * STEP, v: 2 }];
		const x = (extra: Partial<SparklineSpec>) => Number(/<rect x="(\d+)"/.exec(composeSparkline(spec(bar, { bars: true, ...extra })))![1]);
		assert.ok(x({ bucketAnchor: "start" }) > x({ bucketAnchor: "middle" }));
	});
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isSvgDataUri, MAX_IMAGE_BYTES, SVG_DATA_URI_PREFIX, svgToDataUri } from "../src/render/data-uri.ts";
import { GLYPH_NAMES } from "../src/render/glyph-names.ts";
import { GLYPHS } from "../src/render/generated/glyphs.ts";
import { composeDialIcon, composeTile, escapeXml, fitFontSize } from "../src/render/tile.ts";

describe("composeTile", () => {
	it("is a 144x144 svg with a background and the glyph", () => {
		const svg = composeTile({ glyph: "thermometer", accent: "#4FD1B5" });
		assert.match(svg, /^<svg [^>]*width="144" height="144"/);
		assert.match(svg, /<rect width="144" height="144"/);
		assert.ok(svg.includes(GLYPHS.thermometer));
		assert.ok(svg.endsWith("</svg>"));
		assert.equal(svg.includes("<text"), false, "no text unless bigText is requested");
	});

	it("draws trend, min/max hint and a status dot only when asked", () => {
		const plain = composeTile({ glyph: "gauge", accent: "#4FD1B5" });
		assert.equal(plain.includes("<circle"), false);
		const full = composeTile({ glyph: "gauge", accent: "#4FD1B5", trend: "up", minMaxHint: true, status: "stale" });
		assert.ok(full.includes(GLYPHS["arrow-up"]));
		assert.ok(full.includes(GLYPHS["arrow-up-to-line"]) && full.includes(GLYPHS["arrow-down-to-line"]));
		assert.ok(full.includes("<circle"));
		assert.equal(composeTile({ glyph: "gauge", accent: "#4FD1B5", status: "ok" }).includes("<circle"), false);
	});

	it("dimming changes the picture and is deterministic", () => {
		const lit = composeTile({ glyph: "wind", accent: "#58C97A" });
		const dim = composeTile({ glyph: "wind", accent: "#58C97A", dim: true });
		assert.notEqual(lit, dim);
		assert.equal(dim, composeTile({ glyph: "wind", accent: "#58C97A", dim: true }));
	});

	it("never lets an invalid colour into the markup", () => {
		const svg = composeTile({ glyph: "wind", accent: '"/><script>alert(1)</script>' });
		assert.equal(svg.includes("<script"), false);
		assert.match(svg, /stroke="#[0-9a-f]{6}"/i);
	});

	it("bigText is escaped and draws SVG text", () => {
		const svg = composeTile({ glyph: "thermometer", accent: "#4FD1B5", bigText: { value: '21.4<&">', unit: "°C" } });
		assert.ok(svg.includes("<text"));
		assert.ok(svg.includes("21.4&lt;&amp;&quot;&gt;"));
		assert.equal(svg.includes('21.4<&">'), false);
	});

	it("a quantised input yields an identical image (what image de-duplication relies on)", () => {
		const a = composeTile({ glyph: "thermometer", accent: "#4FD1B5", trend: "stable" });
		const b = composeTile({ glyph: "thermometer", accent: "#4FD1B5", trend: "stable" });
		assert.equal(a, b);
	});

	it("has a generated glyph for every name the renderers can ask for", () => {
		for (const name of GLYPH_NAMES) assert.ok(GLYPHS[name] && GLYPHS[name].length > 10, name);
	});
});

describe("helpers", () => {
	it("escapes the five XML characters", () => {
		assert.equal(escapeXml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
	});

	it("fits text and never goes below a legible size", () => {
		assert.equal(fitFontSize(3, 124, 52), 52);
		assert.ok(fitFontSize(8, 124, 52) < 52);
		assert.equal(fitFontSize(80, 124, 52), 12);
	});

	it("composes a dial icon at 48x48", () => {
		assert.match(composeDialIcon("gauge", "#4FD1B5"), /width="48" height="48"/);
	});
});

describe("svgToDataUri", () => {
	it("wraps as base64 and round-trips", () => {
		const svg = composeTile({ glyph: "droplets", accent: "#4FB3F6" });
		const uri = svgToDataUri(svg);
		assert.ok(uri.startsWith(SVG_DATA_URI_PREFIX));
		assert.equal(isSvgDataUri(uri), true);
		assert.equal(Buffer.from(uri.slice(SVG_DATA_URI_PREFIX.length), "base64").toString("utf8"), svg);
		assert.equal(isSvgDataUri(svg), false, "a raw svg string is not a data URI");
	});

	it("refuses an absurdly large image", () => {
		assert.throws(() => svgToDataUri("x".repeat(MAX_IMAGE_BYTES + 1)), /limit/);
	});
});

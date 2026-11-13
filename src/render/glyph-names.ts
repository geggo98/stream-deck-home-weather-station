/**
 * Names of the Lucide glyphs the renderers can draw.
 *
 * Kept in a hand-written file (not in the generated one) so the generator, the catalog
 * and the renderers agree on one list, while `generated/glyphs.ts` stays purely generated
 * content. Adding a name here and running `npm run generate:icons` is all it takes.
 * Every name must exist in the installed lucide-static (the generator fails otherwise).
 */

export const GLYPH_NAMES = [
	// one per metric
	"thermometer",
	"droplets",
	"leaf",
	"volume-2",
	"gauge",
	"cloud-rain",
	"wind",
	// dial action
	"circle-gauge",
	// focus family: catalog glyphs
	"crosshair",
	"refresh-cw",
	"step-forward",
	"step-back",
	"circle-arrow-right",
	"circle-arrow-left",
	"chevrons-right",
	"chevrons-left",
	"repeat",
	"info",
	"chart-line",
	// focus family: runtime faces (module roles, data age and battery, auto rotate state, history)
	"house",
	"sun",
	"door-open",
	"clock",
	"battery-full",
	"battery-medium",
	"battery-low",
	"pause",
	"hourglass",
	// trend and min/max hints
	"arrow-up",
	"arrow-down",
	"arrow-right",
	"arrow-up-to-line",
	"arrow-down-to-line",
	// status faces
	"triangle-alert",
	"settings",
	"loader",
	"wifi-off",
	"circle-help",
] as const;

export type GlyphName = (typeof GLYPH_NAMES)[number];

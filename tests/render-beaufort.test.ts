/**
 * render/format.ts is the ONE live unit implementation (adapter/station/units.ts is dead code
 * kept only until it is deleted). Its Beaufort table is the standard WMO km/h one; pin the
 * boundaries so the wind unit in use cannot drift from the published table.
 * Table (km/h, lower bound of force n): 0:0 1:1 2:6 3:12 4:20 5:29 6:39 7:50 8:62 9:75 10:89 11:103 12:118
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { beaufort } from "../src/render/format.ts";

const LOWER_BOUNDS_KMH = [0, 1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];

describe("beaufort() against the WMO km/h table", () => {
	it("switches force exactly at each lower bound", () => {
		LOWER_BOUNDS_KMH.forEach((bound, force) => {
			assert.equal(beaufort(bound), force, `${bound} km/h`);
			if (bound > 0) assert.equal(beaufort(bound - 0.5), force - 1, `${bound - 0.5} km/h`);
		});
	});

	it("is monotonic over 0..200 km/h", () => {
		let previous = 0;
		for (let kmh = 0; kmh <= 200; kmh++) {
			const force = beaufort(kmh);
			assert.ok(force >= previous && force <= 12, `${kmh} km/h`);
			previous = force;
		}
	});
});

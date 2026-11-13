/** Adoption: which module a freshly dropped key picks (src/render/select.ts). */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { adoptionCandidate } from "../src/render/select.ts";
import { baseModule, BASE_ID, makeSnapshot, outdoorModule, OUTDOOR_ID, windModule } from "./actions-fixtures.ts";

describe("adoptionCandidate", () => {
	it("prefers the base station even when an outdoor module that reports the metric comes first", () => {
		const snapshot = makeSnapshot([outdoorModule(), baseModule()]);
		assert.equal(adoptionCandidate(snapshot, "temperature")?.module.id, BASE_ID, "the order the API delivered must not decide");
		assert.equal(adoptionCandidate(snapshot, "humidity")?.module.id, BASE_ID);
	});

	it("takes the first reporting module when the base does not report the metric", () => {
		const snapshot = makeSnapshot([windModule(), baseModule(), outdoorModule()]);
		assert.equal(adoptionCandidate(snapshot, "wind")?.module.role, "wind");
	});

	it("takes the first reporting non-base module before the base that reports nothing", () => {
		const snapshot = makeSnapshot([baseModule({ values: {} }), outdoorModule()]);
		assert.equal(adoptionCandidate(snapshot, "temperature")?.module.id, OUTDOOR_ID);
	});

	it("falls back to the base station, so the key says 'No data' rather than 'Pick module'", () => {
		const snapshot = makeSnapshot([outdoorModule(), baseModule({ values: {} })]);
		assert.equal(adoptionCandidate(snapshot, "wind")?.module.id, BASE_ID);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecrets, redactingLogger, stripQuery } from "../src/adapter/station/redact.ts";
import { RecordingLogger } from "./station-helpers.ts";

const TOKEN = `${"a1".repeat(12)}|${"b2".repeat(16)}`; // documented token format <24 hex>|<32 hex>

describe("redactSecrets", () => {
	it("replaces known secrets, also URL-encoded", () => {
		const secret = "s3cr3t/with+chars==";
		const text = `value ${secret} and ${encodeURIComponent(secret)}`;
		const out = redactSecrets(text, [secret]);
		assert.ok(!out.includes("s3cr3t"));
		assert.ok(!out.includes(encodeURIComponent(secret)));
	});

	it("ignores very short known secrets instead of shredding the text", () => {
		assert.equal(redactSecrets("abc abc", ["abc"]), "abc abc");
	});

	it("masks bearer tokens and Authorization headers", () => {
		assert.ok(!redactSecrets(`Authorization: Bearer ${TOKEN}`).includes(TOKEN));
		assert.equal(redactSecrets("sent Bearer abcdef123456 now"), "sent Bearer *** now");
	});

	it("masks JSON token fields", () => {
		const json = '{"access_token":"AAA111bbb","refresh_token":"CCC222ddd","client_secret":"EEE333fff","expires_in":10800}';
		const out = redactSecrets(json);
		for (const v of ["AAA111bbb", "CCC222ddd", "EEE333fff"]) assert.ok(!out.includes(v), v);
		assert.ok(out.includes("10800"));
	});

	it("masks form bodies and query strings", () => {
		const out = redactSecrets("grant_type=refresh_token&refresh_token=RT123456&client_id=ID1&client_secret=SEC123456");
		assert.ok(!out.includes("RT123456") && !out.includes("SEC123456"));
		assert.ok(out.includes("client_id=ID1"));
		const cb = redactSecrets("GET /callback?code=CODE123456&state=ST123456");
		assert.ok(!cb.includes("CODE123456") && !cb.includes("ST123456"));
	});

	it("does not mangle 'error_code=3'", () => {
		assert.equal(redactSecrets("error_code=3"), "error_code=3");
	});

	it("masks the bare token format", () => {
		assert.ok(!redactSecrets(`token ${TOKEN} end`).includes(TOKEN));
	});
});

describe("stripQuery and redactingLogger", () => {
	it("drops query and fragment", () => {
		assert.equal(stripQuery("https://x.example/api?a=1#f"), "https://x.example/api");
		assert.equal(stripQuery("https://x.example/api"), "https://x.example/api");
	});

	it("redacts and escapes every level", () => {
		const base = new RecordingLogger();
		const log = redactingLogger(base, () => ["hunter2hunter2"]);
		log.info("pw hunter2hunter2 \u001b[31mred");
		log.error("Bearer abcdefgh1234");
		const text = base.text();
		assert.ok(!text.includes("hunter2hunter2"));
		assert.ok(!text.includes("abcdefgh1234"));
		assert.ok(!text.includes("\u001b"), "control characters must be escaped");
	});
});

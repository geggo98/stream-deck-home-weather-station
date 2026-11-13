import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { NetatmoError } from "../src/adapter/station/errors.ts";
import { MIN_REQUEST_GAP_MS, Poller, clampIntervalSeconds } from "../src/adapter/station/poller.ts";
import { parseStationsResponse } from "../src/adapter/station/parse.ts";
import type { ConnectionState, StationSnapshot } from "../src/adapter/station/types.ts";
import { FakeClock, RecordingLogger, fixture } from "./station-helpers.ts";

const SEC = 1000;
const snapshotAt = (fetchedAt: number): StationSnapshot => parseStationsResponse(fixture("stations-full"), fetchedAt);

interface Harness {
	clock: FakeClock;
	poller: Poller;
	calls: number[];
	next: Array<StationSnapshot | Error | Promise<StationSnapshot>>;
	creds: { has: boolean };
	states: ConnectionState[];
	logger: RecordingLogger;
}

function harness(opts: { random?: number; interval?: number } = {}): Harness {
	const clock = new FakeClock();
	const calls: number[] = [];
	const next: Harness["next"] = [];
	const creds = { has: true };
	const logger = new RecordingLogger();
	const poller = new Poller({
		fetchSnapshot: async () => {
			calls.push(clock.now());
			const item = next.length > 1 ? next.shift()! : (next[0] ?? snapshotAt(clock.now()));
			if (item instanceof Error) throw item;
			return item;
		},
		hasCredentials: async () => creds.has,
		intervalSeconds: opts.interval,
		now: clock.now,
		random: () => opts.random ?? 0.5, // 0.5 = no jitter
		timers: clock.timersApi,
		logger,
	});
	const states: ConnectionState[] = [];
	return { clock, poller, calls, next, creds, states, logger };
}

const transient = (retryAt?: number) => new NetatmoError("transient", "The service is unavailable (HTTP 503)", { retryAt });

describe("Poller: lifecycle", () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	it("does nothing until the first subscriber, then polls immediately", async () => {
		await h.clock.advance(10 * 60 * SEC);
		assert.equal(h.calls.length, 0);
		assert.deepEqual(h.poller.getConnectionState(), { kind: "loading" });
		assert.equal(h.poller.getSnapshot(), undefined);
		let notifications = 0;
		h.poller.subscribe(() => notifications++);
		await h.poller.whenIdle();
		assert.equal(h.calls.length, 1);
		assert.deepEqual(h.poller.getConnectionState(), { kind: "ok" });
		assert.ok(h.poller.getSnapshot());
		assert.ok(notifications >= 1);
	});

	it("polls every 300 s by default, a second subscriber does not add polls, the last unsubscribe stops everything", async () => {
		const a = h.poller.subscribe(() => undefined);
		const b = h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		await h.clock.advance(300 * SEC);
		assert.equal(h.calls.length, 2);
		a.unsubscribe();
		await h.clock.advance(300 * SEC);
		assert.equal(h.calls.length, 3, "still one subscriber");
		b.unsubscribe();
		b.unsubscribe(); // idempotent
		assert.equal(h.clock.pending, 0, "no timer left after the last unsubscribe");
		await h.clock.advance(3600 * SEC);
		assert.equal(h.calls.length, 3);
	});

	it("re-subscribing right after a request does not hit the API again (page flip)", async () => {
		const first = h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		first.unsubscribe();
		await h.clock.advance(5 * SEC);
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		assert.equal(h.calls.length, 1);
		assert.equal(h.clock.pending, 1, "the next poll is scheduled");
		await h.clock.advance(MIN_REQUEST_GAP_MS * 6);
		assert.equal(h.calls.length, 2);
	});

	it("applies +-10 % jitter around the interval", async () => {
		for (const [random, expected] of [[0, 270], [1, 330], [0.5, 300]] as const) {
			const j = harness({ random });
			j.poller.subscribe(() => undefined);
			await j.poller.whenIdle();
			assert.equal(j.clock.nextIn, expected * SEC, `random=${random}`);
		}
	});

	it("clamps the interval to 60..3600 s", async () => {
		assert.equal(clampIntervalSeconds(5), 60);
		assert.equal(clampIntervalSeconds(99_999), 3600);
		assert.equal(clampIntervalSeconds(Number.NaN), 300);
		assert.equal(clampIntervalSeconds(120.4), 120);
		const j = harness({ interval: 1 });
		assert.equal(j.poller.intervalSeconds, 60);
		j.poller.subscribe(() => undefined);
		await j.poller.whenIdle();
		assert.equal(j.clock.nextIn, 60 * SEC);
		j.poller.setIntervalSeconds(1200);
		assert.equal(j.clock.nextIn, 1200 * SEC, "a healthy schedule is re-planned");
	});

	it("isolates listeners: one that throws neither breaks the others nor the poller", async () => {
		let good = 0;
		h.poller.subscribe(() => {
			throw new Error("boom");
		});
		h.poller.subscribe(() => good++);
		await h.poller.whenIdle();
		assert.ok(good >= 1);
		await h.clock.advance(300 * SEC);
		assert.equal(h.calls.length, 2);
		assert.ok(h.logger.text().includes("a listener threw"));
	});

	it("dispose stops timers and listeners and is idempotent", async () => {
		let notified = 0;
		h.poller.subscribe(() => notified++);
		await h.poller.whenIdle();
		h.poller.dispose();
		h.poller.dispose();
		const before = notified;
		await h.clock.advance(3600 * SEC);
		assert.equal(h.calls.length, 1);
		assert.equal(notified, before);
		await h.poller.refresh();
		assert.equal(h.calls.length, 1);
	});
});

describe("Poller: errors and backoff", () => {
	it("backs off x2 per consecutive failure up to 3600 s, keeps the last good snapshot, and recovers", async () => {
		const h = harness();
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		const good = h.poller.getSnapshot();
		h.next.splice(0, h.next.length, transient());
		const delays: number[] = [];
		let last = h.calls[h.calls.length - 1]!;
		await h.clock.advance(300 * SEC); // second poll: first failure
		for (let i = 0; i < 8; i++) {
			delays.push(h.clock.nextIn! / SEC);
			await h.clock.advance(h.clock.nextIn!);
			last = h.calls[h.calls.length - 1]!;
		}
		assert.deepEqual(delays, [300, 600, 1200, 2400, 3600, 3600, 3600, 3600]);
		assert.equal(h.poller.getSnapshot(), good, "snapshot survives errors");
		const state = h.poller.getConnectionState();
		assert.equal(state.kind, "error");
		if (state.kind === "error") {
			assert.equal(state.message, "The service is unavailable (HTTP 503)");
			assert.ok(state.since <= last);
			assert.ok(state.retryAt > h.clock.now());
		}
		// recovery
		h.next.splice(0, h.next.length, snapshotAt(h.clock.now()));
		await h.clock.advance(h.clock.nextIn!);
		assert.deepEqual(h.poller.getConnectionState(), { kind: "ok" });
		assert.notEqual(h.poller.getSnapshot(), good);
		assert.equal(h.clock.nextIn, 300 * SEC, "back to the normal interval");
	});

	it("error.since stays at the first failure of a streak", async () => {
		const h = harness();
		h.next.push(transient());
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		const first = h.poller.getConnectionState();
		await h.clock.advance(h.clock.nextIn!);
		const second = h.poller.getConnectionState();
		assert.equal(first.kind, "error");
		assert.equal(second.kind, "error");
		if (first.kind === "error" && second.kind === "error") {
			assert.equal(second.since, first.since);
			assert.ok(second.retryAt > first.retryAt);
		}
	});

	it("respects Retry-After beyond the normal backoff, and manual refresh cannot bypass it", async () => {
		const h = harness();
		const retryAt = h.clock.now() + 1800 * SEC;
		h.next.push(new NetatmoError("rate-limited", "The service is rate limiting requests", { status: 429, retryAt }));
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		assert.equal(h.clock.nextIn, 1800 * SEC);
		await h.clock.advance(120 * SEC);
		await h.poller.refresh();
		assert.equal(h.calls.length, 1, "refresh must not beat the Retry-After");
		await h.clock.advance(1800 * SEC);
		assert.equal(h.calls.length, 2);
	});

	it("caps an absurd Retry-After at one hour", async () => {
		const h = harness();
		h.next.push(new NetatmoError("rate-limited", "x", { retryAt: h.clock.now() + 48 * 3600 * SEC }));
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		assert.equal(h.clock.nextIn, 3600 * SEC);
	});

	it("auth errors stop polling until credentialsChanged()", async () => {
		const h = harness();
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		h.next.splice(0, h.next.length, new NetatmoError("auth", "The refresh token was rejected or has been revoked. Sign in again."));
		await h.clock.advance(300 * SEC);
		const state = h.poller.getConnectionState();
		assert.equal(state.kind, "auth-error");
		assert.equal(h.clock.pending, 0);
		const calls = h.calls.length;
		await h.clock.advance(7200 * SEC);
		await h.poller.refresh();
		assert.equal(h.calls.length, calls, "no request while in auth-error");
		// a new subscriber does not restart it either
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		assert.equal(h.calls.length, calls);
		// new credentials: restart, old snapshot dropped
		h.next.splice(0, h.next.length, snapshotAt(h.clock.now()));
		await h.poller.credentialsChanged();
		assert.equal(h.calls.length, calls + 1);
		assert.deepEqual(h.poller.getConnectionState(), { kind: "ok" });
		assert.equal(h.clock.pending, 1);
	});

	it("an unexpected non-Netatmo exception is a transient error with a generic message", async () => {
		const h = harness();
		h.next.push(new TypeError("cannot read property of undefined: SECRET-FRAGMENT"));
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		const state = h.poller.getConnectionState();
		assert.equal(state.kind, "error");
		assert.ok(!JSON.stringify(state).includes("SECRET-FRAGMENT"));
		// the user-facing state stays generic, but the cause is logged (the service's redacting logger masks secrets in it)
		assert.match(h.logger.text(), /ERROR .*unexpected error: TypeError: cannot read property of undefined/);
		assert.match(h.logger.text(), /ERROR .* @ /, "with the first stack frames");
	});
});

describe("Poller: credentials", () => {
	it("no credentials: no request, state no-credentials; credentialsChanged picks them up", async () => {
		const h = harness();
		h.creds.has = false;
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		assert.deepEqual(h.poller.getConnectionState(), { kind: "no-credentials" });
		assert.equal(h.calls.length, 0);
		assert.equal(h.clock.pending, 0);
		await h.poller.refresh();
		assert.equal(h.calls.length, 0);
		h.creds.has = true;
		await h.poller.credentialsChanged();
		assert.equal(h.calls.length, 1);
		assert.deepEqual(h.poller.getConnectionState(), { kind: "ok" });
	});

	it("clearing credentials drops the snapshot and shows no-credentials", async () => {
		const h = harness();
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		h.creds.has = false;
		await h.poller.credentialsChanged();
		assert.equal(h.poller.getSnapshot(), undefined);
		assert.deepEqual(h.poller.getConnectionState(), { kind: "no-credentials" });
		assert.equal(h.clock.pending, 0);
	});

	it("a poll that started under the old credentials is discarded when it finishes", async () => {
		const h = harness();
		let release!: (s: StationSnapshot) => void;
		h.next.push(new Promise<StationSnapshot>((resolve) => (release = resolve)));
		h.poller.subscribe(() => undefined);
		await h.clock.settle();
		assert.equal(h.calls.length, 1);
		h.next.splice(0, h.next.length, snapshotAt(h.clock.now() + 1));
		const changed = h.poller.credentialsChanged();
		release(snapshotAt(1)); // the OLD account's data arrives late
		await changed;
		assert.notEqual(h.poller.getSnapshot()?.fetchedAt, 1);
		assert.equal(h.calls.length, 2);
	});

	it("adoptSnapshot installs a snapshot fetched during validation without another request", async () => {
		const h = harness();
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		const adopted = snapshotAt(h.clock.now());
		h.poller.adoptSnapshot(adopted);
		assert.equal(h.poller.getSnapshot(), adopted);
		assert.deepEqual(h.poller.getConnectionState(), { kind: "ok" });
		assert.equal(h.calls.length, 1);
		assert.equal(h.clock.pending, 1);
		await h.poller.refresh(); // throttled right after
		assert.equal(h.calls.length, 1);
	});
});

describe("Poller: refresh()", () => {
	it("coalesces concurrent refreshes into one request", async () => {
		const h = harness();
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		await h.clock.advance(MIN_REQUEST_GAP_MS + 1);
		let release!: (s: StationSnapshot) => void;
		h.next.splice(0, h.next.length, new Promise<StationSnapshot>((resolve) => (release = resolve)));
		const before = h.calls.length;
		const all = [h.poller.refresh(), h.poller.refresh(), h.poller.refresh()];
		await h.clock.settle();
		assert.equal(h.calls.length, before + 1);
		release(snapshotAt(h.clock.now()));
		await Promise.all(all);
		assert.equal(h.calls.length, before + 1);
	});

	it("is rate limited to one real request per 60 s and resolves at once from the cache", async () => {
		const h = harness();
		h.poller.subscribe(() => undefined);
		await h.poller.whenIdle();
		const cached = h.poller.getSnapshot();
		await h.clock.advance(30 * SEC);
		await h.poller.refresh();
		assert.equal(h.calls.length, 1);
		assert.equal(h.poller.getSnapshot(), cached);
		await h.clock.advance(31 * SEC);
		h.next.splice(0, h.next.length, snapshotAt(h.clock.now()));
		await h.poller.refresh();
		assert.equal(h.calls.length, 2);
		assert.equal(h.clock.nextIn, 300 * SEC, "the interval restarts after a manual refresh");
	});
});

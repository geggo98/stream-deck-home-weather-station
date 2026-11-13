/**
 * Shared test support for tests/station-*.test.ts (not a test file itself: the npm script
 * only runs *.test.ts). SDK-free, like the adapter.
 *
 * All identifiers here are fictional: MAC addresses from the documentation range
 * 00:00:5e:00:53:xx, token values that are obviously fake.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { AdapterLogger } from "../src/adapter/logging.ts";
import type { PollerTimers } from "../src/adapter/station/poller.ts";

/** 100 s after the newest measurement in tests/fixtures/station/stations-full.json (time_utc 1700000000). */
export const T0 = 1_700_000_100_000;

export function fixture(name: string): any {
	const file = path.join(import.meta.dirname, "fixtures", "station", `${name}.json`);
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

export async function makeTempDir(t: TestContext): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hws-test-"));
	t.after(() => fsp.rm(dir, { recursive: true, force: true }));
	return dir;
}

export class RecordingLogger implements AdapterLogger {
	readonly lines: string[] = [];
	debug(message: string): void {
		this.lines.push(`DEBUG ${message}`);
	}
	info(message: string): void {
		this.lines.push(`INFO ${message}`);
	}
	warn(message: string): void {
		this.lines.push(`WARN ${message}`);
	}
	error(message: string): void {
		this.lines.push(`ERROR ${message}`);
	}
	text(): string {
		return this.lines.join("\n");
	}
}

// ---- HTTP double ----

export interface RecordedRequest {
	readonly method: string;
	readonly url: string;
	readonly path: string;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

export type Handler = (req: RecordedRequest, res: http.ServerResponse) => void | Promise<void>;

export interface ApiDouble {
	readonly baseUrl: string;
	readonly requests: RecordedRequest[];
	/** Route key: "<METHOD> <path without query>". A function handles every request; an array is consumed one entry per request (the last one repeats). */
	route(key: string, handler: Handler | Handler[]): void;
	requestsTo(key: string): RecordedRequest[];
	close(): Promise<void>;
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

export async function startApiDouble(t: TestContext): Promise<ApiDouble> {
	const requests: RecordedRequest[] = [];
	const routes = new Map<string, Handler | Handler[]>();
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const url = req.url ?? "/";
			const recorded: RecordedRequest = {
				method: req.method ?? "GET",
				url,
				path: url.split("?")[0] ?? url,
				headers: req.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			};
			requests.push(recorded);
			const key = `${recorded.method} ${recorded.path}`;
			const entry = routes.get(key);
			let handler: Handler | undefined;
			if (Array.isArray(entry)) handler = entry.length > 1 ? entry.shift() : entry[0];
			else handler = entry;
			if (!handler) {
				sendJson(res, 404, { error: { code: 31, message: "no route in test double" } });
				return;
			}
			Promise.resolve(handler(recorded, res)).catch(() => {
				if (!res.headersSent) sendJson(res, 500, { error: "double failed" });
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const double: ApiDouble = {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		route: (key, handler) => void routes.set(key, handler),
		requestsTo: (key) => requests.filter((r) => `${r.method} ${r.path}` === key),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
	t.after(() => double.close());
	return double;
}

/** Token endpoint that issues AT-1/RT-1, AT-2/RT-2, ... and records nothing itself (the double does). */
export function tokenIssuer(prefix = "fake"): Handler {
	let n = 0;
	return (_req, res) => {
		n++;
		sendJson(res, 200, { access_token: `${prefix}-access-${n}`, refresh_token: `${prefix}-refresh-${n}`, expires_in: 10800 });
	};
}

export function stationsOk(body: unknown = fixture("stations-full")): Handler {
	return (_req, res) => sendJson(res, 200, body);
}

// ---- fake clock ----

const flush = async (): Promise<void> => {
	for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

export class FakeClock {
	nowMs: number;
	private nextId = 1;
	private timers: Array<{ id: number; at: number; fn: () => void }> = [];

	constructor(start = T0) {
		this.nowMs = start;
	}

	readonly now = (): number => this.nowMs;

	readonly timersApi: PollerTimers = {
		setTimeout: (fn, ms) => {
			const id = this.nextId++;
			this.timers.push({ id, at: this.nowMs + ms, fn });
			return id;
		},
		clearTimeout: (handle) => {
			this.timers = this.timers.filter((t) => t.id !== handle);
		},
	};

	get pending(): number {
		return this.timers.length;
	}

	/** Milliseconds until the next timer fires, or undefined. */
	get nextIn(): number | undefined {
		const first = [...this.timers].sort((a, b) => a.at - b.at)[0];
		return first ? first.at - this.nowMs : undefined;
	}

	async settle(): Promise<void> {
		await flush();
	}

	async advance(ms: number): Promise<void> {
		const target = this.nowMs + ms;
		await flush();
		for (;;) {
			const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
			if (!due) break;
			this.timers = this.timers.filter((t) => t.id !== due.id);
			this.nowMs = Math.max(this.nowMs, due.at);
			due.fn();
			await flush();
		}
		this.nowMs = target;
		await flush();
	}
}

/**
 * Local request budget shared by everything that calls the data API through one client
 * (poller and history). The service limits a user to 50 requests per 10 s and 500 per hour
 * (docs/WEATHER-API.md); a local counter keeps optional traffic (history) away from those
 * limits before the service has to say no. Pure: the clock is passed in.
 *
 * `record` counts a request that was sent. `check` says whether an OPTIONAL request may be
 * sent: it keeps `reserve` requests of the hourly budget for the poller, which is never
 * blocked by this class.
 */

export const BUDGET_SHORT_WINDOW_MS = 10_000;
export const BUDGET_SHORT_LIMIT = 50;
export const BUDGET_LONG_WINDOW_MS = 3_600_000;
export const BUDGET_LONG_LIMIT = 500;
/** Hourly requests kept free for polling when optional requests ask. */
export const BUDGET_POLLER_RESERVE = 100;

export type BudgetCheck = { readonly ok: true } | { readonly ok: false; readonly retryAt: number };

export class RequestBudget {
	private stamps: number[] = [];

	private prune(now: number): void {
		const cutoff = now - BUDGET_LONG_WINDOW_MS;
		let i = 0;
		while (i < this.stamps.length && this.stamps[i]! <= cutoff) i++;
		if (i > 0) this.stamps = this.stamps.slice(i);
	}

	record(now: number): void {
		this.prune(now);
		this.stamps.push(now);
	}

	check(now: number, reserve = BUDGET_POLLER_RESERVE): BudgetCheck {
		this.prune(now);
		const shortCount = this.stamps.filter((s) => s > now - BUDGET_SHORT_WINDOW_MS);
		if (shortCount.length >= BUDGET_SHORT_LIMIT) return { ok: false, retryAt: shortCount[0]! + BUDGET_SHORT_WINDOW_MS };
		const allowed = BUDGET_LONG_LIMIT - reserve;
		if (this.stamps.length >= allowed) return { ok: false, retryAt: this.stamps[this.stamps.length - allowed]! + BUDGET_LONG_WINDOW_MS };
		return { ok: true };
	}

	get used(): number {
		return this.stamps.length;
	}
}

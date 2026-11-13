/**
 * Catch-and-log for fire-and-forget SDK calls (setTitle, setImage, setFeedback, ...)
 * made from synchronous code. Node 24 runs with unhandled rejections fatal, so every
 * dropped promise must be caught somewhere; this is that somewhere.
 *
 * `onError` runs after the log line. Painters use it to forget what they believed they
 * had painted, so the next repaint writes again instead of treating a rejected write as done.
 */
export function fireAndLog(
	promise: Promise<unknown>,
	logger: { error(message: string): void },
	what: string,
	onError?: () => void,
): void {
	promise.catch((err) => {
		logger.error(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
		try {
			onError?.();
		} catch {
			// A cleanup hook must not turn a logged failure into an unhandled rejection.
		}
	});
}

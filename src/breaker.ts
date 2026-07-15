/**
 * Circuit breaker for the run loop: one bad issue must never stop the run,
 * but a string of unexpected exceptions almost certainly means something
 * systemic is broken (auth expired, remote unreachable, disk full), so
 * ploughing through the rest of the queue would only spray failed-attempt
 * comments across every issue.
 */
export class ConsecutiveFailureBreaker {
	private consecutive = 0;

	constructor(private readonly limit: number = 2) {
		if (limit < 1) throw new Error("ConsecutiveFailureBreaker limit must be >= 1");
	}

	/** Record an unexpected failure. Returns true when the breaker trips (stop the run). */
	recordFailure(): boolean {
		this.consecutive += 1;
		return this.consecutive >= this.limit;
	}

	/** Any issue that completes without an unexpected exception resets the streak. */
	recordSuccess(): void {
		this.consecutive = 0;
	}
}

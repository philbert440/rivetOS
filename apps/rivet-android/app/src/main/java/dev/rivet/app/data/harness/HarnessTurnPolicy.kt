package dev.rivet.app.data.harness

/**
 * What to do with a turn the driver would not take. Pure policy, so the
 * bounded-retry rule is unit-testable without a node.
 *
 * `turn_in_flight` is not a failure: v1 drivers MUST NOT silently queue, so a
 * mid-turn send is simply "not yet". The turn stays queued and is retried on a
 * bounded exponential backoff; past the cap it stays queued for the user's own
 * (interrupting) send, because a harness parked on its own TUI permission
 * prompt is legitimately mid-turn for as long as a human takes, and a
 * fixed-interval retry would POST at it forever.
 *
 * Mirrors the hub's rule in `apps/rivethub-web/src/pages/chat.tsx`.
 */
sealed class TurnOutcome {
    /** Accepted by the driver. */
    object Sent : TurnOutcome()

    /** `turn_in_flight`: keep it queued and retry after [delayMs]. */
    data class Retry(val attempt: Int, val delayMs: Long) : TurnOutcome()

    /** `turn_in_flight` past the retry cap: keep it queued, stop retrying. */
    data class Parked(val attempt: Int) : TurnOutcome()

    /** A real failure — surface it. */
    data class Failed(val error: Throwable) : TurnOutcome()
}

object HarnessTurnPolicy {

    /** First backoff after a `turn_in_flight` rejection; doubles per attempt. */
    const val RETRY_BASE_MS = 1_500L
    const val RETRY_MAX_MS = 30_000L

    /**
     * Cap the retries: past this the turn sits in the queue with its send
     * button, which is better than an infinite background poll.
     */
    const val RETRY_ATTEMPTS = 6

    /**
     * Classify one send attempt. [previousAttempts] is how many times this same
     * turn has already been rejected with `turn_in_flight`.
     */
    fun classify(error: Throwable?, previousAttempts: Int): TurnOutcome {
        if (error == null) return TurnOutcome.Sent
        if (!HarnessPlane.isTurnInFlight(error)) return TurnOutcome.Failed(error)
        val attempt = previousAttempts + 1
        if (attempt > RETRY_ATTEMPTS) return TurnOutcome.Parked(attempt)
        return TurnOutcome.Retry(attempt, backoffMs(attempt))
    }

    /** 1.5s, 3s, 6s, 12s, 24s, 30s (capped). */
    fun backoffMs(attempt: Int): Long {
        if (attempt <= 1) return RETRY_BASE_MS
        val shift = minOf(attempt - 1, 20)
        val raw = RETRY_BASE_MS shl shift
        return if (raw <= 0 || raw > RETRY_MAX_MS) RETRY_MAX_MS else raw
    }
}

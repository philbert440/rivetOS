package dev.rivet.app.data.harness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Bounded `turn_in_flight` retry. v1 drivers never queue, so a mid-turn send is
 * "not yet" rather than a failure — but a harness parked on its own TUI
 * permission prompt is mid-turn until a human answers, so the retry has to
 * stop.
 */
class HarnessTurnPolicyTest {

    private fun busy() = HarnessHttpException(409, "turn_in_flight", "mid turn", null)

    @Test
    fun `no error is a send`() {
        assertTrue(HarnessTurnPolicy.classify(null, 0) is TurnOutcome.Sent)
    }

    @Test
    fun `turn_in_flight retries on a doubling backoff, capped`() {
        val delays = (0 until HarnessTurnPolicy.RETRY_ATTEMPTS).map { previous ->
            val outcome = HarnessTurnPolicy.classify(busy(), previous)
            assertTrue(outcome is TurnOutcome.Retry)
            (outcome as TurnOutcome.Retry).delayMs
        }
        assertEquals(listOf(1_500L, 3_000L, 6_000L, 12_000L, 24_000L, 30_000L), delays)
        assertTrue(delays.all { it <= HarnessTurnPolicy.RETRY_MAX_MS })
    }

    @Test
    fun `past the cap the turn is parked, not failed`() {
        val outcome = HarnessTurnPolicy.classify(busy(), HarnessTurnPolicy.RETRY_ATTEMPTS)
        assertTrue(outcome is TurnOutcome.Parked)
        assertEquals(HarnessTurnPolicy.RETRY_ATTEMPTS + 1, (outcome as TurnOutcome.Parked).attempt)
    }

    @Test
    fun `anything that is not turn_in_flight fails the turn`() {
        val collision = HarnessHttpException(409, "session_id_collision", "taken", null)
        assertTrue(HarnessTurnPolicy.classify(collision, 0) is TurnOutcome.Failed)
        val unsupported = HarnessHttpException(501, "capability_unsupported", "no", null)
        assertTrue(HarnessTurnPolicy.classify(unsupported, 0) is TurnOutcome.Failed)
        assertTrue(HarnessTurnPolicy.classify(RuntimeException("boom"), 3) is TurnOutcome.Failed)
    }

    @Test
    fun `backoff never overflows or goes negative`() {
        assertEquals(HarnessTurnPolicy.RETRY_BASE_MS, HarnessTurnPolicy.backoffMs(0))
        assertEquals(HarnessTurnPolicy.RETRY_BASE_MS, HarnessTurnPolicy.backoffMs(1))
        assertEquals(HarnessTurnPolicy.RETRY_MAX_MS, HarnessTurnPolicy.backoffMs(64))
        assertTrue(HarnessTurnPolicy.backoffMs(1_000) > 0)
    }
}

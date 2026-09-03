package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessSessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InjectTest {
    private class Clock(var t: Long = 0) {
        fun now(): Long = t
        fun advance(ms: Long) { t += ms }
    }

    private val uuid = "a1b2c3d4-1111-4222-8333-444455556666"
    private val canonical = "claude-code:$uuid"

    private fun summary(sessionId: String, redirectedTo: String? = null) = HarnessSessionSummary(
        sessionId = sessionId,
        harnessId = "claude-code",
        createdAt = "2026-08-08T00:00:00.000Z",
        updatedAt = "2026-08-08T00:05:00.000Z",
        redirectedTo = redirectedTo,
    )

    @Test fun `fresh spawn waits - reused and reattached inject immediately`() {
        assertTrue(ptySpawnIsFresh(alreadyHeld = false, reattached = false))
        assertFalse(ptySpawnIsFresh(alreadyHeld = true, reattached = false))
        assertFalse(ptySpawnIsFresh(alreadyHeld = false, reattached = true))
    }

    @Test fun `ready gate needs output then 1_5s quiet`() {
        val clock = Clock(0)
        val gate = PtyReadyGate(clock::now)
        assertFalse(gate.isReady())
        gate.onOutput()
        clock.advance(PTY_READY_QUIET_MS - 1)
        assertFalse(gate.isReady())
        clock.advance(1)
        assertTrue(gate.isReady())
    }

    @Test fun `ready gate trips the 8s bound with no output`() {
        val clock = Clock(0)
        val gate = PtyReadyGate(clock::now)
        clock.advance(PTY_READY_BOUND_MS - 1)
        assertFalse(gate.isReady())
        clock.advance(1)
        assertTrue(gate.isReady())
    }

    @Test fun `ready gate quiet window restarts on more output`() {
        val clock = Clock(0)
        val gate = PtyReadyGate(clock::now)
        gate.onOutput()
        clock.advance(1_000)
        gate.onOutput()
        clock.advance(PTY_READY_QUIET_MS - 1)
        assertFalse(gate.isReady())
        clock.advance(1)
        assertTrue(gate.isReady())
    }

    @Test fun `bare submit is one-shot at 15s unless already adopted`() {
        assertFalse(shouldBareSubmit(adopted = false, elapsedMs = BARE_SUBMIT_AFTER_MS - 1, alreadySubmitted = false))
        assertTrue(shouldBareSubmit(adopted = false, elapsedMs = BARE_SUBMIT_AFTER_MS, alreadySubmitted = false))
        assertFalse(shouldBareSubmit(adopted = true, elapsedMs = BARE_SUBMIT_AFTER_MS, alreadySubmitted = false))
        assertFalse(shouldBareSubmit(adopted = false, elapsedMs = 20_000, alreadySubmitted = true))
    }

    @Test fun `sessionMatchesNative compares native halves`() {
        assertTrue(sessionMatchesNative(canonical, uuid))
        assertTrue(sessionMatchesNative(uuid, uuid))
        assertTrue(sessionMatchesNative(canonical, canonical))
        assertFalse(sessionMatchesNative("claude-code:other", uuid))
        assertFalse(sessionMatchesNative(null, uuid))
        assertTrue(sessionMatchesNative(canonical, uuid))
        assertTrue(sessionMatchesNative("claude-code:$uuid", uuid))
    }

    @Test fun `sessionMatchesNative matches previousSessionId and redirectedTo`() {
        assertTrue(sessionMatchesNative("claude-code:$uuid", uuid))
        assertTrue(sessionMatchesNative(uuid, uuid))
        val row = summary(canonical, redirectedTo = canonical)
        assertEquals(canonical, canonicalFromSessions(listOf(row), uuid))
    }

    @Test fun `listSessions row whose native id matches the draft is adopted`() {
        val miss = summary("claude-code:bbbbbbbb-2222-4333-8444-555566667777")
        val hit = summary(canonical)
        assertNull(canonicalFromSessions(listOf(miss), uuid))
        assertEquals(canonical, canonicalFromSessions(listOf(miss, hit), uuid))
        assertEquals(canonical, canonicalFromSessions(listOf(summary("x", redirectedTo = canonical)), uuid))
        assertTrue(shouldPollSessions(SESSION_POLL_BOUND_MS))
        assertFalse(shouldPollSessions(SESSION_POLL_BOUND_MS + 1))
    }
}

package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors rivethub-web `lib/finished-turns.test.ts`. */
class FinishedTurnsTest {
    @Test
    fun `reports only active to idle edges`() {
        val t = FinishedTurnTracker()
        assertFalse(t.onStatus("a", "active"))
        assertFalse(t.onStatus("b", "idle"))
        assertTrue(t.onStatus("a", "idle"))
        assertFalse(t.onStatus("a", "idle"))
        assertFalse(t.onStatus("b", "idle"))
    }

    @Test
    fun `a session seen for the first time never notifies`() {
        assertFalse(FinishedTurnTracker().onStatus("new", "idle"))
    }

    @Test
    fun `an error or end is not a finished reply`() {
        val t = FinishedTurnTracker()
        t.onStatus("a", "active")
        assertFalse(t.onStatus("a", "error"))
        t.onStatus("b", "active")
        assertFalse(t.onStatus("b", "ended"))
    }

    @Test
    fun `a rekey mid-turn carries the active status to the new id`() {
        val t = FinishedTurnTracker()
        t.onStatus("6f1c0e3a", "active")
        assertTrue(t.onStatus("codex:6f1c0e3a", "idle", previousSessionId = "6f1c0e3a"))
    }

    @Test
    fun `the conversation on screen is not notified, any other is`() {
        assertFalse(shouldNotifyAgentFinished(enabled = false, appResumed = false, sessionId = "codex:a", openSessionKey = null))
        assertTrue(shouldNotifyAgentFinished(enabled = true, appResumed = false, sessionId = "codex:a", openSessionKey = "codex:a"))
        assertFalse(shouldNotifyAgentFinished(enabled = true, appResumed = true, sessionId = "codex:a", openSessionKey = "codex:a"))
        assertFalse(shouldNotifyAgentFinished(enabled = true, appResumed = true, sessionId = "codex:a", openSessionKey = "a"))
        assertTrue(shouldNotifyAgentFinished(enabled = true, appResumed = true, sessionId = "codex:b", openSessionKey = "codex:a"))
        assertTrue(shouldNotifyAgentFinished(enabled = true, appResumed = true, sessionId = "codex:b", openSessionKey = null))
    }

    @Test
    fun `body names the conversation, or its id when untitled`() {
        assertEquals("Fix the den", agentFinishedBody(" Fix the den ", "claude-code:x"))
        assertEquals("claude-code:x", agentFinishedBody(null, "claude-code:x"))
        assertEquals("claude-code:x", agentFinishedBody("  ", "claude-code:x"))
    }
}

package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompactCommandTest {
    @Test
    fun `claude harness ids compact with slash compact`() {
        assertEquals("/compact", compactCommandFor("claude-code"))
        assertEquals("/compact", compactCommandFor("claude"))
        assertEquals("/compact", compactCommandFor(" Claude-Code "))
    }

    @Test
    fun `other harnesses and blanks have no compact command`() {
        for (id in listOf("codex", "grok-build", "kimi-code", "hermes", "opencode", "pi", "qwen-code")) {
            assertNull(id, compactCommandFor(id))
        }
        assertNull(compactCommandFor(null))
        assertNull(compactCommandFor(""))
        assertNull(compactCommandFor("   "))
    }

    @Test
    fun `can compact only for claude and never while in flight`() {
        assertTrue(canCompact("claude-code", inFlight = false))
        assertFalse(canCompact("claude-code", inFlight = true))
        assertFalse(canCompact("codex", inFlight = false))
        assertFalse(canCompact(null, inFlight = false))
    }

    private val idle = CompactCheck(sessionId = "claude-code:s1", draft = false, inFlight = false, outboundBusy = false)

    @Test
    fun `compaction dispatches when nothing moved during pty setup`() {
        assertTrue(compactMayDispatch("claude-code", idle, idle))
        assertFalse(compactMayDispatch("codex", idle, idle))
        assertFalse(compactMayDispatch(null, idle, idle))
    }

    @Test
    fun `a turn or send that started during pty setup wins over compaction`() {
        // confirm while idle → user sends while ensurePty / waitUntilPtyReady suspend
        assertFalse(compactMayDispatch("claude-code", idle, idle.copy(inFlight = true)))
        assertFalse(compactMayDispatch("claude-code", idle, idle.copy(outboundBusy = true)))
        assertFalse(compactMayDispatch("claude-code", idle, idle.copy(inFlight = true, outboundBusy = true)))
    }

    @Test
    fun `compaction refuses a draft a busy start or a changed session`() {
        assertFalse(compactMayDispatch("claude-code", idle.copy(draft = true), idle.copy(draft = true)))
        assertFalse(compactMayDispatch("claude-code", idle.copy(inFlight = true), idle))
        assertFalse(compactMayDispatch("claude-code", idle.copy(outboundBusy = true), idle))
        assertFalse(compactMayDispatch("claude-code", idle, idle.copy(sessionId = "claude-code:s2")))
    }
}

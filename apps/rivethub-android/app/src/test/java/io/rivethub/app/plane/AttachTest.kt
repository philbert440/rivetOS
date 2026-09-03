package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessTranscriptTurn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachTest {
    private class Clock(var t: Long = 0) {
        fun now(): Long = t
        fun advance(ms: Long) { t += ms }
    }

    private fun turns(vararg texts: String) =
        texts.map { HarnessTranscriptTurn(role = "assistant", text = it) }

    @Test fun `onOpen replaces and does not merge`() {
        val m = TranscriptMachine({ 0 })
        m.onOpen(turns("a", "b"))
        m.onOpen(turns("c"))
        assertEquals(listOf("c"), m.transcript.map { it.text })
        assertEquals("", m.liveText)
    }

    @Test fun `onTurnComplete replaces and does not merge`() {
        val m = TranscriptMachine({ 0 })
        m.onOpen(turns("old"))
        m.onFrame(HarnessEvent.AssistantDelta("s", "delta"))
        m.onTurnComplete(turns("committed"))
        assertEquals(listOf("committed"), m.transcript.map { it.text })
        assertEquals("", m.liveText)
        assertFalse(m.inFlight)
        assertNull(m.turnStartTs)
    }

    @Test fun `a merge would duplicate - assert it does not`() {
        val m = TranscriptMachine({ 0 })
        val committed = turns("hello")
        m.onOpen(committed)
        m.onFrame(HarnessEvent.AssistantDelta("s", "hello"))
        m.onTurnComplete(committed)
        assertEquals(1, m.transcript.size)
        assertEquals("hello", m.transcript.single().text)
    }

    @Test fun `onFrame appends deltas onto the live slot`() {
        val m = TranscriptMachine({ 1 })
        m.onOpen(turns("prior"))
        m.onFrame(HarnessEvent.AssistantDelta("s", "hel"))
        m.onFrame(HarnessEvent.AssistantDelta("s", "lo"))
        assertEquals("hello", m.liveText)
        assertEquals(listOf("prior"), m.transcript.map { it.text })
        assertTrue(m.inFlight)
    }

    @Test fun `beginTurn sets inFlight and turnStartTs`() {
        val clock = Clock(1_000)
        val m = TranscriptMachine(clock::now)
        assertFalse(m.inFlight)
        m.beginTurn()
        assertTrue(m.inFlight)
        assertEquals(1_000L, m.turnStartTs)
        assertEquals(1_000L, m.lastFrameTs)
    }

    @Test fun `idle deadline trips after 3 minutes of silence`() {
        val clock = Clock(0)
        val m = TranscriptMachine(clock::now)
        m.beginTurn()
        clock.advance(IDLE_DEADLINE_MS - 1)
        assertFalse(m.idleTimedOut())
        clock.advance(1)
        assertTrue(m.idleTimedOut())
    }

    @Test fun `idle deadline is re-armed on every stream frame`() {
        val clock = Clock(0)
        val m = TranscriptMachine(clock::now)
        m.beginTurn()
        clock.advance(IDLE_DEADLINE_MS - 1)
        m.onFrame(HarnessEvent.AssistantDelta("s", "."))
        clock.advance(IDLE_DEADLINE_MS - 1)
        assertFalse(m.idleTimedOut())
        clock.advance(1)
        assertTrue(m.idleTimedOut())
    }

    @Test fun `tool frames re-arm without appending text`() {
        val clock = Clock(0)
        val m = TranscriptMachine(clock::now)
        m.beginTurn()
        clock.advance(10_000)
        m.onFrame(HarnessEvent.ToolUse("s", "c1", "Bash"))
        assertEquals(10_000L, m.lastFrameTs)
        assertEquals("", m.liveText)
        assertTrue(m.inFlight)
    }

    @Test fun `unknown frames re-arm the clock and do not throw`() {
        val clock = Clock(5)
        val m = TranscriptMachine(clock::now)
        m.beginTurn()
        clock.t = 50
        m.onFrame(HarnessEvent.Unknown("approval-request", kotlinx.serialization.json.buildJsonObject {}))
        assertEquals(50L, m.lastFrameTs)
        assertTrue(m.inFlight)
    }

    @Test fun `error frame clears inFlight`() {
        val m = TranscriptMachine({ 0 })
        m.beginTurn()
        m.onFrame(HarnessEvent.Error("s", "invalid_session_id", "gone"))
        assertFalse(m.inFlight)
    }
}

package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessTranscriptTurn
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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

    @Test fun `rearmIdle extends the deadline after adoption`() {
        val clock = Clock(0)
        val m = TranscriptMachine(clock::now)
        m.beginTurn()
        clock.advance(IDLE_DEADLINE_MS - 1)
        assertFalse(m.idleTimedOut())
        m.rearmIdle()
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

    @Test fun `turn-complete frame clears inFlight`() {
        val m = TranscriptMachine({ 0 })
        m.beginTurn()
        val verdict = m.onFrame(HarnessEvent.TurnComplete("s", "t1", "end-turn"))
        assertEquals(FrameVerdict.Continue, verdict)
        assertFalse(m.inFlight)
        assertEquals("", m.liveText)
    }

    @Test fun `fatal codes report fatal retryable and unknown do not`() {
        val m = TranscriptMachine({ 0 })
        m.beginTurn()
        assertEquals(FrameVerdict.Fatal, m.onFrame(HarnessEvent.Error("", "invalid_session_id", "gone")))
        assertEquals(FrameVerdict.Fatal, m.onFrame(HarnessEvent.Error("", "capability_unsupported", "nope")))
        assertEquals(FrameVerdict.Fatal, m.onFrame(HarnessEvent.Error("", "forbidden", "tenancy")))
        assertEquals(FrameVerdict.Continue, m.onFrame(HarnessEvent.Error("", "upstream", "tmp", retryable = true)))
        assertEquals(FrameVerdict.Continue, m.onFrame(HarnessEvent.Error("", "unknown_code", "x")))
    }

    @Test fun `attach fetches transcript on open`() = runBlocking {
        withTimeout(1_000) {
            var fetches = 0
            val m = TranscriptMachine({ 0 })
            val attach = SessionAttach(
                machine = m,
                fetchTranscript = {
                    fetches++
                    turns("committed")
                },
                settleMs = 0,
            )
            attach.onWatchOpen()
            assertEquals(1, fetches)
            assertEquals(listOf("committed"), m.transcript.map { it.text })
            assertEquals("", m.liveText)
        }
    }

    @Test fun `attach fetches transcript on turn-complete after settle`() = runBlocking {
        withTimeout(1_000) {
            var fetches = 0
            val m = TranscriptMachine({ 0 })
            val attach = SessionAttach(
                machine = m,
                fetchTranscript = {
                    fetches++
                    turns("after")
                },
                settleMs = 400,
            )
            attach.onFrame(HarnessEvent.TurnComplete("s", "t1", "end-turn"))
            assertEquals(0, fetches)
            attach.flushCommittedResync()
            assertEquals(1, fetches)
            assertEquals(listOf("after"), m.transcript.map { it.text })
            assertFalse(m.inFlight)
        }
    }

    @Test fun `three frames during settle are applied in order and none is lost`() = runBlocking {
        withTimeout(1_000) {
            val m = TranscriptMachine({ 0 })
            val attach = SessionAttach(
                machine = m,
                fetchTranscript = { turns("committed") },
                settleMs = 400,
            )
            attach.onFrame(HarnessEvent.TurnComplete("s", "t1", "end-turn"))
            attach.onFrame(HarnessEvent.AssistantDelta("s", "a"))
            attach.onFrame(HarnessEvent.AssistantDelta("s", "b"))
            attach.onFrame(HarnessEvent.AssistantDelta("s", "c"))
            assertEquals("abc", m.liveText)
            attach.flushCommittedResync()
            assertEquals(listOf("committed"), m.transcript.map { it.text })
            assertEquals("abc", m.liveText)
        }
    }

    @Test fun `detach stops without firing onFatal or closeWatch`() = runBlocking {
        withTimeout(1_000) {
            var closed = 0
            var fatal: String? = null
            val m = TranscriptMachine({ 0 })
            val attach = SessionAttach(
                machine = m,
                fetchTranscript = { turns("stale") },
                onFatal = { fatal = it },
                closeWatch = { closed++ },
            )
            attach.detach()
            assertTrue(attach.stopped)
            assertEquals(0, closed)
            assertNull(fatal)
            attach.onFrame(HarnessEvent.AssistantDelta("s", "nope"))
            attach.flushCommittedResync()
            assertEquals("", m.liveText)
            assertEquals(emptyList<String>(), m.transcript.map { it.text })
        }
    }

    @Test fun `fatal error frame stops the watch`() = runBlocking {
        withTimeout(1_000) {
            var closed = 0
            var fatal: String? = null
            val attach = SessionAttach(
                machine = TranscriptMachine({ 0 }),
                fetchTranscript = { emptyList() },
                onFatal = { fatal = it },
                closeWatch = { closed++ },
                settleMs = 0,
            )
            attach.onFrame(HarnessEvent.Error("", "invalid_session_id", "gone"))
            assertEquals(1, closed)
            assertEquals("gone", fatal)
            assertTrue(attach.stopped)
            attach.onFrame(HarnessEvent.AssistantDelta("s", "nope"))
            assertEquals(1, closed)
        }
    }

    @Test fun `transcript 404 and 410 are fatal and close the watch`() = runBlocking {
        withTimeout(1_000) {
            var closed = 0
            var fatal: String? = null
            val attach404 = SessionAttach(
                machine = TranscriptMachine({ 0 }),
                fetchTranscript = { throw GatewayException(404, "unknown session") },
                onFatal = { fatal = it },
                closeWatch = { closed++ },
                settleMs = 0,
            )
            attach404.onWatchOpen()
            assertEquals(1, closed)
            assertEquals("unknown session", fatal)
            assertTrue(attach404.stopped)

            val attach410 = SessionAttach(
                machine = TranscriptMachine({ 0 }),
                fetchTranscript = { throw GatewayException(410, "gone") },
                onFatal = { fatal = it },
                closeWatch = { closed++ },
                settleMs = 0,
            )
            attach410.onWatchOpen()
            assertEquals(2, closed)
            assertEquals("gone", fatal)
            assertTrue(attach410.stopped)

            val attach503 = SessionAttach(
                machine = TranscriptMachine({ 0 }),
                fetchTranscript = { throw GatewayException(503, "restarting") },
                onFatal = { fatal = it },
                closeWatch = { closed++ },
                settleMs = 0,
            )
            attach503.onWatchOpen()
            assertEquals(2, closed)
            assertFalse(attach503.stopped)
        }
    }
}

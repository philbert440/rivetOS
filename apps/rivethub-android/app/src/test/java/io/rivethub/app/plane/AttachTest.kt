package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessSessionSummary
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

    private fun u(text: String) = HarnessTranscriptTurn(role = "user", text = text)
    private fun a(text: String) = HarnessTranscriptTurn(role = "assistant", text = text)
    private fun tx(
        rev: Int,
        from: Int,
        total: Int,
        turns: List<HarnessTranscriptTurn>,
        command: String = "claude",
        truncatedBefore: Boolean = false,
    ) = HarnessEvent.Transcript(
        sessionId = "s",
        rev = rev,
        from = from,
        total = total,
        turns = turns,
        command = command,
        truncatedBefore = truncatedBefore,
    )

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

    @Test fun `optimistic user turn is visible before any frame`() {
        val m = TranscriptMachine({ 0 })
        m.appendOptimisticUser("hello")
        m.beginTurn()
        assertEquals(listOf("user" to "hello"), m.transcript.map { it.role to it.text })
        assertTrue(m.inFlight)
    }

    @Test fun `resync dedupes the optimistic user turn`() {
        val m = TranscriptMachine({ 0 })
        m.appendOptimisticUser("hello")
        m.beginTurn()
        m.onTurnComplete(
            listOf(
                HarnessTranscriptTurn(role = "user", text = "hello"),
                HarnessTranscriptTurn(role = "assistant", text = "hi"),
            ),
        )
        assertEquals(listOf("hello", "hi"), m.transcript.map { it.text })
        assertEquals(listOf("user", "assistant"), m.transcript.map { it.role })
        assertFalse(m.inFlight)
    }

    @Test fun `onOpen keeps unmatched optimistic user`() {
        val m = TranscriptMachine({ 0 })
        m.appendOptimisticUser("hello")
        m.beginTurn()
        m.onOpen(emptyList())
        assertEquals(listOf("hello"), m.transcript.map { it.text })
        assertEquals("user", m.transcript.single().role)
        assertTrue(m.inFlight)
    }

    @Test fun `SessionUpdated idle while in flight should resync`() {
        val sid = "claude-code:a1b2c3d4-1111-4222-8333-444455556666"
        val idle = HarnessEvent.SessionUpdated(sessionId = sid, status = "idle")
        assertTrue(
            shouldResyncFromRegistry(
                inFlight = true,
                matchesOpenSession = registryEventMatchesOpen(idle, sid),
                status = idle.status,
                updatedAt = idle.updatedAt,
                lastStatus = "active",
                lastUpdatedAt = "t0",
            ),
        )
        assertFalse(
            shouldResyncFromRegistry(
                inFlight = false,
                matchesOpenSession = true,
                status = "idle",
                updatedAt = null,
                lastStatus = "active",
                lastUpdatedAt = "t0",
            ),
        )
        val ended = HarnessEvent.SessionUpdated(sessionId = sid, status = "ended")
        assertTrue(
            shouldResyncFromRegistry(
                inFlight = true,
                matchesOpenSession = registryEventMatchesOpen(ended, sid),
                status = ended.status,
                updatedAt = null,
                lastStatus = "active",
                lastUpdatedAt = null,
            ),
        )
        assertTrue(
            shouldResyncFromRegistry(
                inFlight = true,
                matchesOpenSession = true,
                status = "active",
                updatedAt = "t1",
                lastStatus = "active",
                lastUpdatedAt = "t0",
            ),
        )
    }

    @Test fun `SessionCreated active first sight does not resync`() {
        val sid = "claude-code:a1b2c3d4-1111-4222-8333-444455556666"
        val created = HarnessEvent.SessionCreated(
            sessionId = sid,
            summary = HarnessSessionSummary(
                sessionId = sid,
                harnessId = "claude-code",
                createdAt = "2026-08-08T00:00:00.000Z",
                updatedAt = "2026-08-08T00:05:00.000Z",
                status = "active",
            ),
        )
        val stamp = registryStamp(created)!!
        assertFalse(
            shouldResyncFromRegistry(
                inFlight = true,
                matchesOpenSession = registryEventMatchesOpen(created, sid),
                status = stamp.status,
                updatedAt = stamp.updatedAt,
                lastStatus = null,
                lastUpdatedAt = null,
            ),
        )
    }

    @Test fun `SessionUpdated resync ends the in-flight turn`() = runBlocking {
        withTimeout(1_000) {
            val m = TranscriptMachine({ 0 })
            m.appendOptimisticUser("hello")
            m.beginTurn()
            val attach = SessionAttach(
                machine = m,
                fetchTranscript = {
                    listOf(
                        HarnessTranscriptTurn(role = "user", text = "hello"),
                        HarnessTranscriptTurn(role = "assistant", text = "yo"),
                    )
                },
                settleMs = 0,
            )
            attach.resyncCommitted()
            assertFalse(m.inFlight)
            assertEquals(listOf("hello", "yo"), m.transcript.map { it.text })
            assertEquals("", m.liveText)
        }
    }

    @Test fun `transcript snapshot from 0 replaces turns and sets rev`() {
        val m = TranscriptMachine({ 0 })
        val ok = m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 2, turns = listOf(u("a"), a("b"))))
        assertTrue(ok)
        assertEquals(1, m.rev)
        assertEquals(0, m.offset)
        assertEquals(listOf("a", "b"), m.transcript.map { it.text })
        assertEquals(LiveSource.TRANSCRIPT, m.liveSource)
    }

    @Test fun `transcript delta splices when rev is next`() {
        val m = TranscriptMachine({ 0 })
        assertTrue(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 1, turns = listOf(u("a")))))
        assertTrue(m.applyTranscriptFrame(tx(rev = 2, from = 1, total = 2, turns = listOf(a("b")))))
        assertEquals(2, m.rev)
        assertEquals(listOf("a", "b"), m.transcript.map { it.text })
    }

    @Test fun `rev gap returns false so caller syncs`() {
        val m = TranscriptMachine({ 0 })
        assertTrue(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 1, turns = listOf(u("a")))))
        assertFalse(m.applyTranscriptFrame(tx(rev = 3, from = 1, total = 2, turns = listOf(a("b")))))
        assertEquals(1, m.rev)
        assertEquals(listOf("a"), m.transcript.map { it.text })
    }

    @Test fun `truncatedBefore pins the earlier prefix`() {
        val m = TranscriptMachine({ 0 })
        assertTrue(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 3, turns = listOf(u("a"), a("b"), u("c")))))
        assertTrue(
            m.applyTranscriptFrame(
                tx(rev = 2, from = 0, total = 2, turns = listOf(a("b"), u("c")), truncatedBefore = true),
            ),
        )
        assertEquals(listOf("a", "b", "c"), m.transcript.map { it.text })
        assertEquals(1, m.offset)
    }

    @Test fun `total mismatch returns false`() {
        val m = TranscriptMachine({ 0 })
        assertFalse(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 5, turns = listOf(u("a")))))
        assertEquals(-1, m.rev)
        assertTrue(m.transcript.isEmpty())
    }

    @Test fun `trailing incomplete assistant is live not committed`() {
        val m = TranscriptMachine({ 0 })
        val live = HarnessTranscriptTurn(role = "assistant", text = "partial", thinking = "hmm", complete = null)
        assertTrue(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 2, turns = listOf(u("hi"), live))))
        m.onStatus(HarnessEvent.Status("s", "working", 1, phase = "writing"))
        assertEquals(listOf("hi"), m.committedTurns.map { it.text })
        assertEquals("partial", m.liveText)
        assertEquals("hmm", m.liveReasoning)
        assertTrue(m.inFlight)
        assertFalse(m.transcript.any { it.text == "partial" })
    }

    @Test fun `status idle solidifies the trailing turn`() {
        val m = TranscriptMachine({ 0 })
        val live = HarnessTranscriptTurn(role = "assistant", text = "done", complete = null)
        assertTrue(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 2, turns = listOf(u("hi"), live))))
        m.onStatus(HarnessEvent.Status("s", "working", 1, phase = "writing"))
        assertEquals("done", m.liveText)
        assertFalse(m.committedTurns.any { it.text == "done" })
        m.onStatus(HarnessEvent.Status("s", "idle", 2))
        assertFalse(m.inFlight)
        assertEquals("", m.liveText)
        assertEquals(listOf("hi", "done"), m.transcript.map { it.text })
    }

    @Test fun `codex is a live-turn store like kimi`() {
        assertTrue(isLiveTurnStore("kimi"))
        assertTrue(isLiveTurnStore("kimi-code"))
        assertTrue(isLiveTurnStore("codex"))
        assertTrue(isLiveTurnStore("opencode"))
        assertFalse(isLiveTurnStore("dsh"))
    }

    @Test fun `hook deltas ignored on a live-turn store`() {
        val m = TranscriptMachine({ 0 })
        val live = HarnessTranscriptTurn(role = "assistant", text = "from-store", complete = null)
        assertTrue(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 1, turns = listOf(live))))
        m.onStatus(HarnessEvent.Status("s", "working", 1, phase = "writing"))
        m.onFrame(HarnessEvent.AssistantDelta("s", "hook-text"))
        m.onFrame(HarnessEvent.ReasoningDelta("s", "hook-think"))
        assertEquals("from-store", m.liveText)
        assertFalse(m.liveText.contains("hook-text"))
        assertEquals(LiveSource.TRANSCRIPT, m.liveSource)
    }

    @Test fun `hook deltas applied on a text-only store`() {
        val m = TranscriptMachine({ 0 })
        assertTrue(
            m.applyTranscriptFrame(
                tx(rev = 1, from = 0, total = 1, turns = listOf(u("hi")), command = "dsh"),
            ),
        )
        assertEquals(LiveSource.HOOKS, m.liveSource)
        m.onFrame(HarnessEvent.AssistantDelta("s", "hel"))
        m.onFrame(HarnessEvent.AssistantDelta("s", "lo"))
        assertEquals("hello", m.liveText)
        assertTrue(m.inFlight)
    }

    @Test fun `interrupted turn renders truncated`() {
        val m = TranscriptMachine({ 0 })
        val cut = HarnessTranscriptTurn(
            role = "assistant",
            text = "half",
            stopReason = "interrupted",
            complete = null,
        )
        assertTrue(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 2, turns = listOf(u("hi"), cut))))
        m.onStatus(HarnessEvent.Status("s", "idle", 1))
        assertFalse(m.inFlight)
        assertEquals("", m.liveText)
        assertEquals(listOf("hi", "half"), m.transcript.map { it.text })
        assertEquals("interrupted", m.transcript.last().stopReason)
    }

    @Test fun `delta after pin uses the offset`() {
        val m = TranscriptMachine({ 0 })
        assertTrue(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 3, turns = listOf(u("a"), a("b"), u("c")))))
        assertTrue(
            m.applyTranscriptFrame(
                tx(rev = 2, from = 0, total = 2, turns = listOf(a("b"), u("c")), truncatedBefore = true),
            ),
        )
        assertTrue(m.applyTranscriptFrame(tx(rev = 3, from = 2, total = 3, turns = listOf(a("d")))))
        assertEquals(listOf("a", "b", "c", "d"), m.transcript.map { it.text })
        assertEquals(1, m.offset)
    }

    @Test fun `status working without complete keeps inFlight`() {
        val m = TranscriptMachine({ 0 })
        assertTrue(m.applyTranscriptFrame(tx(rev = 1, from = 0, total = 1, turns = listOf(u("hi")))))
        m.onStatus(HarnessEvent.Status("s", "working", 1, phase = "thinking"))
        assertTrue(m.inFlight)
        assertEquals("thinking…", agentStatusLine("working", "thinking", null))
        assertEquals("running Bash…", agentStatusLine("working", "tool", "Bash"))
        assertEquals("writing…", agentStatusLine("working", "writing", null))
        assertEquals("waiting for you", agentStatusLine("blocked", null, null))
    }

    @Test fun `409 pending-on-server then assistant on disk completes the turn`() {
        val m = TranscriptMachine({ 0 })
        m.appendOptimisticUser("hello")
        m.beginTurn()
        val injectCompleted = injectCompletedAfterSend(ok = false, turnInFlight409 = true)
        assertTrue(injectCompleted)
        assertFalse(injectCompletedAfterSend(ok = false, turnInFlight409 = false))
        val fetched = listOf(
            HarnessTranscriptTurn(role = "user", text = "hello"),
            HarnessTranscriptTurn(role = "assistant", text = "yo"),
        )
        val complete = resyncCompletesTurn(
            fetched = fetched,
            pendingUserText = m.pendingUserText,
            committedPrefix = m.committedAtTurnStart,
            injectCompleted = injectCompleted,
        )
        assertTrue(complete)
        m.applyFetched(fetched, complete = true)
        assertFalse(m.inFlight)
        assertEquals(listOf("hello", "yo"), m.transcript.map { it.text })
    }

    @Test fun `resync is discarded if the open session changed mid-fetch`() {
        val old = "claude-code:aaaa"
        val next = "claude-code:bbbb"
        assertTrue(resyncStillApplies(old, old, attachUnchanged = true))
        assertFalse(resyncStillApplies(old, next, attachUnchanged = true))
        assertFalse(resyncStillApplies(old, old, attachUnchanged = false))
        assertFalse(resyncStillApplies("", old, attachUnchanged = true))
    }

    @Test fun `idempotent adopt of the same canonical id is a no-op`() {
        val sid = "claude-code:a1b2c3d4-1111-4222-8333-444455556666"
        assertTrue(adoptCanonicalIsNoOp(canonical = sid, currentSessionId = sid, draft = false))
        assertTrue(adoptCanonicalIsNoOp(canonical = sid, currentSessionId = sid, draft = false))
        assertTrue(adoptCanonicalIsNoOp(canonical = "", currentSessionId = sid, draft = false))
        assertFalse(adoptCanonicalIsNoOp(canonical = sid, currentSessionId = "draft-uuid", draft = true))
        assertFalse(adoptCanonicalIsNoOp(canonical = sid, currentSessionId = sid, draft = true))
    }
}

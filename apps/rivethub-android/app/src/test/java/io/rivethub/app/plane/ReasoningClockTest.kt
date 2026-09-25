package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReasoningClockTest {
    private val tpl: (String) -> String = { "Reasoned for $it" }

    @Test fun `first reasoning delta starts the span once`() {
        val none: ReasoningSpan? = null
        val a = none.onReasoningDelta(1_000)
        assertEquals(ReasoningSpan(1_000, null), a)
        val b = a.onReasoningDelta(2_500)
        assertEquals(ReasoningSpan(1_000, null), b)
    }

    @Test fun `first non-reasoning ends the span once`() {
        val open = ReasoningSpan(1_000, null)
        val ended = open.onFirstNonReasoning(4_400)
        assertEquals(ReasoningSpan(1_000, 4_400), ended)
        assertEquals(ReasoningSpan(1_000, 4_400), ended.onFirstNonReasoning(9_000))
        // a delta after the end does not reopen it
        assertEquals(ReasoningSpan(1_000, 4_400), ended.onReasoningDelta(9_500))
    }

    @Test fun `non-reasoning with no span stays null`() {
        val none: ReasoningSpan? = null
        assertNull(none.onFirstNonReasoning(5_000))
    }

    @Test fun `end never precedes start`() {
        assertEquals(ReasoningSpan(1_000, 1_000), ReasoningSpan(1_000, null).onFirstNonReasoning(900))
    }

    @Test fun `label is one decimal seconds rounded half up`() {
        assertEquals("Reasoned for 3.4s", reasoningLabel(ReasoningSpan(0, 3_449), 0, tpl))
        assertEquals("Reasoned for 3.5s", reasoningLabel(ReasoningSpan(0, 3_450), 0, tpl))
        assertEquals("Reasoned for 0.0s", reasoningLabel(ReasoningSpan(0, 49), 0, tpl))
        assertEquals("Reasoned for 0.1s", reasoningLabel(ReasoningSpan(0, 50), 0, tpl))
        assertEquals("Reasoned for 10.0s", reasoningLabel(ReasoningSpan(0, 9_960), 0, tpl))
        assertEquals("Reasoned for 61.2s", reasoningLabelMs(61_234, tpl))
    }

    @Test fun `open span label ticks against now`() {
        val span = ReasoningSpan(10_000, null)
        assertEquals("Reasoned for 2.0s", reasoningLabel(span, 12_000, tpl))
        assertEquals("Reasoned for 3.0s", reasoningLabel(span, 13_000, tpl))
        // a closed span ignores now
        assertEquals("Reasoned for 1.5s", reasoningLabel(ReasoningSpan(10_000, 11_500), 99_000, tpl))
    }

    @Test fun `autoCollapse only once the span has ended`() {
        assertFalse(autoCollapse(null))
        assertFalse(autoCollapse(ReasoningSpan(0, null)))
        assertTrue(autoCollapse(ReasoningSpan(0, 1)))
    }

    @Test fun `advance opens on reasoning and closes on text`() {
        val s1 = advanceReasoning(null, 100, wasInFlight = false, inFlight = true, reasoningSeen = true, nonReasoningSeen = false)
        assertTrue(s1.turnStarted)
        assertEquals(ReasoningSpan(100, null), s1.span)
        assertNull(s1.finishedMs)
        val s2 = advanceReasoning(s1.span, 2_100, wasInFlight = true, inFlight = true, reasoningSeen = true, nonReasoningSeen = true)
        assertFalse(s2.turnStarted)
        assertEquals(ReasoningSpan(100, 2_100), s2.span)
        assertNull(s2.finishedMs)
        val s3 = advanceReasoning(s2.span, 5_000, wasInFlight = true, inFlight = false, reasoningSeen = true, nonReasoningSeen = true)
        assertEquals(ReasoningSpan(100, 2_100), s3.span)
        assertEquals(2_000L, s3.finishedMs)
    }

    @Test fun `advance closes on turn end when reasoning was the whole turn`() {
        val open = ReasoningSpan(0, null)
        val s = advanceReasoning(open, 1_200, wasInFlight = true, inFlight = false, reasoningSeen = true, nonReasoningSeen = false)
        assertEquals(ReasoningSpan(0, 1_200), s.span)
        assertEquals(1_200L, s.finishedMs)
    }

    @Test fun `advance does not start a span first seen after text`() {
        val s = advanceReasoning(null, 100, wasInFlight = true, inFlight = true, reasoningSeen = true, nonReasoningSeen = true)
        assertNull(s.span)
        val done = advanceReasoning(s.span, 200, wasInFlight = true, inFlight = false, reasoningSeen = true, nonReasoningSeen = true)
        assertNull(done.finishedMs)
    }

    @Test fun `a new turn forgets the previous span`() {
        val old = ReasoningSpan(0, 500)
        val s = advanceReasoning(old, 9_000, wasInFlight = false, inFlight = true, reasoningSeen = false, nonReasoningSeen = false)
        assertTrue(s.turnStarted)
        assertNull(s.span)
    }

    @Test fun `reasoning owner prefers the assistant turn that carries thinking`() {
        val turns = listOf(
            HarnessTranscriptTurn(role = "user", text = "q0"),
            HarnessTranscriptTurn(role = "assistant", text = "a0", thinking = "old"),
            HarnessTranscriptTurn(role = "user", text = "q1"),
            HarnessTranscriptTurn(role = "assistant", text = ""),
            HarnessTranscriptTurn(role = "assistant", text = "a1", thinking = "new"),
        )
        assertEquals(4, reasoningOwnerIndex(turns, 2))
        assertEquals(1, reasoningOwnerIndex(turns, 0))
        assertEquals(3, reasoningOwnerIndex(turns.take(4), 2))
        assertNull(reasoningOwnerIndex(turns.take(3), 2))
    }

    private fun user(t: String) = HarnessTranscriptTurn(role = "user", text = t)
    private fun asst(t: String, thinking: String? = null) = HarnessTranscriptTurn(role = "assistant", text = t, thinking = thinking)

    @Test fun `reasoning owner stays inside its own reply and never takes the next turn`() {
        val turns = listOf(user("q1"), asst("a1"), user("q2"), asst("a2", thinking = "t2"))
        assertEquals(1, reasoningOwnerIndex(turns, 0))
        assertEquals(1..1, assistantRun(turns, 0))
        assertEquals(3..3, assistantRun(turns, 2))
        assertNull(assistantRun(turns.take(1), 0))
    }

    @Test fun `queued send right after turn-complete keeps the finished measurement`() {
        // turn 1 starts with two stored turns on disk
        var l = ReasoningLedger().advance(0, wasInFlight = false, inFlight = true, reasoningSeen = false, nonReasoningSeen = false, committedSize = 2)
        l = l.reasoningDelta(1_000)
        l = l.nonReasoning(3_500) // first text closes the span
        l = l.fileSpan(4_000) // turn-complete, before the queue drains
        l = l.startTurn(4_000, committedSize = 2) // queued send begins turn 2 at once
        assertNull(l.span)
        assertEquals(listOf(PendingReasoning(2_500, 2)), l.pending)
        // turn 2 in flight; turn 1 not on disk yet: nothing is filed, nothing is lost
        val early = listOf(user("q0"), asst("a0"), user("q1"), user("q2"))
        val waiting = l.settle(early, inFlight = true)
        assertTrue(waiting.durations.isEmpty())
        assertEquals(l.pending, waiting.ledger.pending)
        // the delayed committed transcript arrives (q2 still the optimistic bubble)
        val landed = listOf(user("q0"), asst("a0"), user("q1"), asst("a1", thinking = "t1"), user("q2"))
        val done = waiting.ledger.settle(landed, inFlight = true)
        assertEquals(mapOf(3 to 2_500L), done.durations)
        assertTrue(done.ledger.pending.isEmpty())
    }

    @Test fun `starting a turn files a span nobody filed`() {
        val l = ReasoningLedger().startTurn(0, committedSize = 4).reasoningDelta(100).startTurn(600, committedSize = 6)
        assertNull(l.span)
        assertEquals(6, l.from)
        assertEquals(listOf(PendingReasoning(500, 4)), l.pending)
    }

    @Test fun `advance files once when the turn ends`() {
        var l = ReasoningLedger().advance(0, wasInFlight = false, inFlight = true, reasoningSeen = true, nonReasoningSeen = false, committedSize = 1)
        assertEquals(ReasoningSpan(0, null), l.span)
        l = l.advance(1_200, wasInFlight = true, inFlight = false, reasoningSeen = true, nonReasoningSeen = false, committedSize = 1)
        assertEquals(ReasoningSpan(0, 1_200), l.span)
        l = l.advance(1_500, wasInFlight = false, inFlight = false, reasoningSeen = true, nonReasoningSeen = false, committedSize = 3)
        assertEquals(listOf(PendingReasoning(1_200, 1)), l.pending)
    }

    @Test fun `a filed or idle ledger ignores stray reasoning frames`() {
        assertNull(ReasoningLedger().reasoningDelta(100).span)
        val filed = ReasoningLedger().startTurn(0, 0).reasoningDelta(100).fileSpan(200)
        val later = filed.reasoningDelta(300)
            .advance(400, wasInFlight = true, inFlight = true, reasoningSeen = true, nonReasoningSeen = false, committedSize = 0)
        assertEquals(ReasoningSpan(100, 200), later.span)
        assertEquals(1, later.pending.size)
        assertEquals(filed, filed.fileSpan(900))
    }

    @Test fun `two finished turns settle onto their own replies in order`() {
        val l = ReasoningLedger(pending = listOf(PendingReasoning(1_000, 2), PendingReasoning(2_000, 2)))
        val turns = listOf(user("q0"), asst("a0"), user("q1"), asst("a1"), user("q2"), asst("a2", thinking = "t"))
        val r = l.settle(turns, inFlight = false)
        assertEquals(mapOf(3 to 1_000L, 5 to 2_000L), r.durations)
        assertTrue(r.ledger.pending.isEmpty())
    }

    @Test fun `an open reply waits until it is closed`() {
        val l = ReasoningLedger(pending = listOf(PendingReasoning(1_000, 2)))
        val turns = listOf(user("q0"), asst("a0"), user("q1"), asst("a1"))
        assertTrue(l.settle(turns, inFlight = true).durations.isEmpty())
        assertEquals(mapOf(3 to 1_000L), l.settle(turns, inFlight = false).durations)
    }

    @Test fun `a turn that never got a reply drops its measurement`() {
        val l = ReasoningLedger(pending = listOf(PendingReasoning(1_000, 2), PendingReasoning(2_000, 3)))
        val turns = listOf(user("q0"), asst("a0"), user("q1"), user("q2"), asst("a2"))
        val r = l.settle(turns, inFlight = false)
        assertEquals(mapOf(4 to 2_000L), r.durations)
        assertTrue(r.ledger.pending.isEmpty())
    }

    @Test fun `a turn settled in a later call never takes the run an earlier call handed out`() {
        // A starts with two stored turns on disk; queued B starts before A's reply lands
        var l = ReasoningLedger().startTurn(0, committedSize = 2).reasoningDelta(0).nonReasoning(1_000)
        l = l.startTurn(2_000, committedSize = 2).reasoningDelta(2_100)
        assertEquals(listOf(PendingReasoning(1_000, 2)), l.pending)
        // A's reply lands while B is still in flight (qB is the open bubble)
        val mid = listOf(user("q0"), asst("a0"), user("qA"), asst("aA", thinking = "tA"), user("qB"))
        val first = l.settle(mid, inFlight = true)
        assertEquals(mapOf(3 to 1_000L), first.durations)
        assertEquals(3, first.ledger.settledUpTo)
        assertEquals(4, first.ledger.from)
        assertEquals(ReasoningSpan(2_100, null), first.ledger.span)
        // B finishes and settles in a separate call: its own reply, A's untouched
        l = first.ledger.nonReasoning(4_600).fileSpan(5_000)
        assertEquals(listOf(PendingReasoning(2_500, 4)), l.pending)
        val done = mid + asst("aB", thinking = "tB")
        val second = l.settle(done, inFlight = false)
        assertEquals(mapOf(5 to 2_500L), second.durations)
        assertTrue(second.ledger.pending.isEmpty())
        assertEquals(5, second.ledger.settledUpTo)
    }

    @Test fun `a measurement left pending keeps its place behind a run already settled`() {
        val l = ReasoningLedger(pending = listOf(PendingReasoning(1_000, 2), PendingReasoning(2_000, 2)))
        val turns = listOf(user("q0"), asst("a0"), user("q1"), asst("a1"), user("q2"), asst("a2"))
        val first = l.settle(turns, inFlight = true)
        assertEquals(mapOf(3 to 1_000L), first.durations)
        assertEquals(listOf(PendingReasoning(2_000, 2)), first.ledger.pending)
        val second = first.ledger.settle(turns, inFlight = false)
        assertEquals(mapOf(5 to 2_000L), second.durations)
        assertTrue(second.ledger.pending.isEmpty())
    }
}

package dev.rivet.app.data.harness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The contract's stream rule, pinned: hard-resync on EVERY open, resync after
 * `turn-complete`, never fold across a gap, and stop for good on a terminal
 * error rather than reconnecting into the same refusal.
 *
 * Twin of `apps/rivethub-web/src/lib/harness-attach.test.ts`.
 */
class HarnessAttachmentTest {

    private val sid = "claude-code:aaa"

    private class FakeSubscription : HarnessSubscription {
        var closed = false
        override fun close() {
            closed = true
        }
    }

    private class FakeGateway(
        var transcripts: MutableList<Result<HarnessTranscript>> = mutableListOf(),
    ) : HarnessAttachGateway {
        var listener: HarnessStreamListener? = null
        val subscription = FakeSubscription()
        var transcriptCalls = 0

        override fun transcript(sessionId: String): HarnessTranscript {
            transcriptCalls++
            val next = if (transcripts.isEmpty()) {
                Result.success(HarnessTranscript(sessionId, "claude-code", emptyList(), null))
            } else {
                transcripts.removeAt(0)
            }
            return next.getOrThrow()
        }

        override fun watchSession(
            sessionId: String,
            listener: HarnessStreamListener,
        ): HarnessSubscription {
            this.listener = listener
            return subscription
        }
    }

    /** Runs scheduled work the moment it is scheduled, so tests never sleep. */
    private class ImmediateScheduler : HarnessScheduler {
        var scheduled = 0
        override fun schedule(delayMs: Long, task: () -> Unit): HarnessCancellable {
            scheduled++
            task()
            return HarnessCancellable { }
        }
    }

    /** Never fires — proves a cancel path without racing a timer. */
    private class NeverScheduler : HarnessScheduler {
        var cancelled = 0
        override fun schedule(delayMs: Long, task: () -> Unit): HarnessCancellable {
            return HarnessCancellable { cancelled++ }
        }
    }

    private class Recorder : HarnessAttachSink {
        val transcripts = mutableListOf<List<HarnessTranscriptTurn>>()
        val lives = mutableListOf<LiveTurn?>()
        val approvals = mutableListOf<HarnessEvent>()
        val errors = mutableListOf<Throwable>()
        val fatals = mutableListOf<String>()
        val statuses = mutableListOf<Boolean>()

        override fun onTranscript(turns: List<HarnessTranscriptTurn>) {
            transcripts.add(turns)
        }

        override fun onLive(turn: LiveTurn?) {
            lives.add(turn)
        }

        override fun onApproval(event: HarnessEvent) {
            approvals.add(event)
        }

        override fun onError(err: Throwable) {
            errors.add(err)
        }

        override fun onFatal(message: String) {
            fatals.add(message)
        }

        override fun onStatus(open: Boolean) {
            statuses.add(open)
        }
    }

    private fun turns(vararg texts: String) = texts.map { HarnessTranscriptTurn("assistant", it) }

    private fun attach(
        gateway: FakeGateway,
        sink: Recorder,
        scheduler: HarnessScheduler = ImmediateScheduler(),
    ) = HarnessAttachment.open(
        gateway = gateway,
        sessionId = sid,
        sink = sink,
        scheduler = scheduler,
        runResync = { it() }, // synchronous, so assertions need no waiting
    )

    @Test
    fun `every open hard-resyncs and clears the live turn`() {
        val gateway = FakeGateway(
            mutableListOf(
                Result.success(HarnessTranscript(sid, "claude-code", turns("first"), null)),
                Result.success(HarnessTranscript(sid, "claude-code", turns("first", "second"), null)),
            ),
        )
        val sink = Recorder()
        attach(gateway, sink)

        gateway.listener!!.onOpen()
        assertEquals(1, gateway.transcriptCalls)
        assertEquals(listOf("first"), sink.transcripts.last().map { it.text })

        // Reconnect: the tail lost whatever happened during the gap, so the
        // only recovery is another full read — never a merge.
        gateway.listener!!.onClosed()
        gateway.listener!!.onOpen()
        assertEquals(2, gateway.transcriptCalls)
        assertEquals(listOf("first", "second"), sink.transcripts.last().map { it.text })
        assertEquals(listOf(true, false, true), sink.statuses)
    }

    @Test
    fun `a reopen drops a live turn folded before the gap`() {
        val gateway = FakeGateway()
        val sink = Recorder()
        attach(gateway, sink)
        gateway.listener!!.onOpen()
        gateway.listener!!.onEvent(HarnessEvent.AssistantDelta(sid, "half a rep"))
        assertEquals("half a rep", sink.lives.last()?.text)

        gateway.listener!!.onOpen()
        // Cleared unconditionally: with no replay nothing would ever supersede
        // a stale bubble.
        assertNull(sink.lives.last())
    }

    @Test
    fun `turn-complete clears the live slot and resyncs after the settle`() {
        val gateway = FakeGateway()
        val sink = Recorder()
        val scheduler = ImmediateScheduler()
        attach(gateway, sink, scheduler)
        gateway.listener!!.onOpen()
        val opens = gateway.transcriptCalls

        gateway.listener!!.onEvent(HarnessEvent.AssistantDelta(sid, "done"))
        gateway.listener!!.onEvent(HarnessEvent.TurnComplete(sid, "end-turn"))

        assertNull(sink.lives.last())
        assertEquals(1, scheduler.scheduled)
        // The committed turn (thinking, tools, usage) comes off the store.
        assertEquals(opens + 1, gateway.transcriptCalls)
    }

    @Test
    fun `approval frames bypass the fold`() {
        val gateway = FakeGateway()
        val sink = Recorder()
        attach(gateway, sink)
        gateway.listener!!.onOpen()
        val livesBefore = sink.lives.size

        gateway.listener!!.onEvent(HarnessEvent.ApprovalRequest(sid, "r1", "Bash", "why"))
        assertEquals(1, sink.approvals.size)
        assertEquals(livesBefore, sink.lives.size)
    }

    @Test
    fun `a terminal error frame stops the attachment instead of looping`() {
        val gateway = FakeGateway()
        val sink = Recorder()
        attach(gateway, sink)
        gateway.listener!!.onOpen()
        val calls = gateway.transcriptCalls

        gateway.listener!!.onEvent(
            HarnessEvent.Error(sid, "capability_unsupported", "no live stream", false),
        )
        assertEquals(listOf("no live stream"), sink.fatals)
        assertTrue(gateway.subscription.closed)

        // Nothing reconnects into the same refusal, and no resync re-arms.
        gateway.listener!!.onOpen()
        assertEquals(calls, gateway.transcriptCalls)
    }

    @Test
    fun `a retryable error frame is folded, not fatal`() {
        val gateway = FakeGateway()
        val sink = Recorder()
        attach(gateway, sink)
        gateway.listener!!.onOpen()
        gateway.listener!!.onEvent(HarnessEvent.Error(sid, "driver_hiccup", "retrying", true))
        assertTrue(sink.fatals.isEmpty())
        assertEquals("retrying", sink.lives.last()?.activity)
    }

    @Test
    fun `a 404 resync is fatal but a 503 is only reported`() {
        val gone = FakeGateway(
            mutableListOf(Result.failure(HarnessHttpException(404, null, "unknown session", null))),
        )
        val goneSink = Recorder()
        attach(gone, goneSink)
        gone.listener!!.onOpen()
        assertEquals(listOf("unknown session"), goneSink.fatals)
        assertTrue(gone.subscription.closed)

        val down = FakeGateway(
            mutableListOf(Result.failure(HarnessHttpException(503, null, "restarting", true))),
        )
        val downSink = Recorder()
        attach(down, downSink)
        down.listener!!.onOpen()
        assertTrue(downSink.fatals.isEmpty())
        assertEquals(1, downSink.errors.size)
        assertFalse(down.subscription.closed)
    }

    @Test
    fun `close releases the socket and cancels a pending settle`() {
        val gateway = FakeGateway()
        val sink = Recorder()
        val scheduler = NeverScheduler()
        val attachment = attach(gateway, sink, scheduler)
        gateway.listener!!.onOpen()
        gateway.listener!!.onEvent(HarnessEvent.TurnComplete(sid, null))

        val calls = gateway.transcriptCalls
        attachment.close()
        assertTrue(gateway.subscription.closed)
        assertEquals(1, scheduler.cancelled)

        // Nothing lands after close.
        attachment.resync()
        gateway.listener!!.onOpen()
        gateway.listener!!.onEvent(HarnessEvent.AssistantDelta(sid, "late"))
        assertEquals(calls, gateway.transcriptCalls)
    }

    @Test
    fun `an explicit resync reads the transcript again`() {
        val gateway = FakeGateway()
        val sink = Recorder()
        val attachment = attach(gateway, sink)
        gateway.listener!!.onOpen()
        val calls = gateway.transcriptCalls
        attachment.resync()
        assertEquals(calls + 1, gateway.transcriptCalls)
    }
}

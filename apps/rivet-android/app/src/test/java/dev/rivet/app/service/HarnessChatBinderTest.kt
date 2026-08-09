package dev.rivet.app.service

import dev.rivet.app.data.harness.ChatRowKind
import dev.rivet.app.data.harness.HarnessCancellable
import dev.rivet.app.data.harness.HarnessCapabilities
import dev.rivet.app.data.harness.HarnessChatRow
import dev.rivet.app.data.harness.HarnessDescriptor
import dev.rivet.app.data.harness.HarnessEvent
import dev.rivet.app.data.harness.HarnessGate
import dev.rivet.app.data.harness.HarnessHttpException
import dev.rivet.app.data.harness.HarnessPlaneSnapshot
import dev.rivet.app.data.harness.HarnessPlaneSource
import dev.rivet.app.data.harness.HarnessScheduler
import dev.rivet.app.data.harness.HarnessSessionGateway
import dev.rivet.app.data.harness.HarnessStreamListener
import dev.rivet.app.data.harness.HarnessSubscription
import dev.rivet.app.data.harness.HarnessTranscript
import dev.rivet.app.data.harness.HarnessTranscriptTurn
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlin.coroutines.EmptyCoroutineContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * The binder layer's own rules: one sender at a time, one commit retires one
 * queued turn, and a fatal stream leaves nothing behind that would keep the
 * composer spinning or the legacy poll suppressed.
 *
 * Everything here runs on `Dispatchers.Unconfined` with an instant `sleep`, so
 * the ordering assertions are deterministic rather than timing-dependent.
 */
@OptIn(ExperimentalUuidApi::class)
class HarnessChatBinderTest {

    private val nativeId = "0f9c2b1a-4d3e-4f5a-9b8c-7d6e5f4a3b2c"
    private val sessionId = "claude-code:$nativeId"
    private val conversationId = Uuid.parse(nativeId)

    // ---- fakes ---------------------------------------------------------------

    private class FakeSubscription : HarnessSubscription {
        var closed = false
        override fun close() {
            closed = true
        }
    }

    private class FakeGateway : HarnessSessionGateway {
        var listener: HarnessStreamListener? = null
        val subscription = FakeSubscription()
        var turns: List<HarnessTranscriptTurn> = emptyList()
        val sent = mutableListOf<String>()
        var interrupts = 0

        /** Set to make the next transcript reads fail (auth, gone, restarting). */
        var transcriptFailure: Throwable? = null

        /** Queue of failures for the next sends; null entries mean "accept". */
        val sendFailures = ArrayDeque<Throwable?>()

        override fun transcript(sessionId: String): HarnessTranscript {
            transcriptFailure?.let { throw it }
            return HarnessTranscript(sessionId, "claude-code", turns, null)
        }

        override fun watchSession(
            sessionId: String,
            listener: HarnessStreamListener,
        ): HarnessSubscription {
            this.listener = listener
            return subscription
        }

        override fun sendTurn(sessionId: String, text: String) {
            val failure = if (sendFailures.isEmpty()) null else sendFailures.removeFirst()
            if (failure != null) throw failure
            sent.add(text)
        }

        override fun interrupt(sessionId: String) {
            interrupts++
        }

        /** Commit turns as the harness store would, then push a resync. */
        fun commitUser(vararg texts: String) {
            turns = turns + texts.map { HarnessTranscriptTurn("user", it) }
        }
    }

    private class FakePlane(
        val gateway: FakeGateway,
        val capabilities: HarnessCapabilities = HarnessCapabilities(
            interrupt = true,
            resume = true,
            approvals = false,
            liveStream = true,
            listSessions = true,
        ),
        val rows: List<HarnessChatRow>,
    ) : HarnessPlaneSource {
        override suspend fun snapshot(maxAgeMs: Long): HarnessPlaneSnapshot =
            HarnessPlaneSnapshot(
                denUrl = "http://node.example:5174",
                descriptors = listOf(HarnessDescriptor("claude-code", capabilities)),
                rows = rows,
            )

        override suspend fun gateway(): HarnessSessionGateway = gateway
    }

    private class ImmediateScheduler : HarnessScheduler {
        override fun schedule(delayMs: Long, task: () -> Unit): HarnessCancellable {
            task()
            return HarnessCancellable { }
        }
    }

    private class NeverScheduler : HarnessScheduler {
        override fun schedule(delayMs: Long, task: () -> Unit) = HarnessCancellable { }
    }

    private class Harness(
        capabilities: HarnessCapabilities? = null,
        scheduler: HarnessScheduler = NeverScheduler(),
    ) {
        val gateway = FakeGateway()
        val renders = mutableListOf<HarnessRender>()
        val surfaced = mutableListOf<String>()
        val slept = mutableListOf<Long>()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        var now = 1_000L

        private val nativeId = "0f9c2b1a-4d3e-4f5a-9b8c-7d6e5f4a3b2c"

        val plane = FakePlane(
            gateway = gateway,
            capabilities = capabilities ?: HarnessCapabilities(
                interrupt = true,
                resume = true,
                approvals = false,
                liveStream = true,
                listSessions = true,
            ),
            rows = listOf(
                HarnessChatRow(
                    key = nativeId,
                    kind = ChatRowKind.HARNESS,
                    title = "thread",
                    sessionId = "claude-code:$nativeId",
                    harnessId = "claude-code",
                    command = "claude",
                ),
            ),
        )

        val binder = HarnessChatBinder(
            scope = scope,
            plane = plane,
            render = { _, snapshot -> renders.add(snapshot) },
            onFatal = { _, message -> surfaced.add(message) },
            scheduler = scheduler,
            // Inherit Unconfined so sends and resyncs land before the assertion.
            io = EmptyCoroutineContext,
            nowMs = { now },
            sleep = { slept.add(it) },
            log = { },
        )

        val listener: HarnessStreamListener get() = gateway.listener!!

        /** Drive a resync the way the socket would. */
        fun resync() {
            listener.onOpen()
        }
    }

    private fun busy() = HarnessHttpException(409, "turn_in_flight", "mid turn", null)

    // ---- binding lifecycle ---------------------------------------------------

    @Test
    fun `bind claims a driver-owned row and publishes the gate on the flow`() = runBlocking {
        val h = Harness()
        assertEquals(HarnessGate.CLOSED, h.binder.gateFlow(conversationId).value)

        val gate = h.binder.bind(conversationId)
        assertTrue(gate.bound)
        assertTrue(h.binder.isBound(conversationId))
        // The flow carries it, not just the return value.
        assertTrue(h.binder.gateFlow(conversationId).value.bound)
        assertTrue(h.binder.gateFlow(conversationId).value.canInterrupt)
        assertEquals(sessionId, h.binder.sessionId(conversationId))
    }

    @Test
    fun `an unclaimed thread stays closed and nothing attaches`() = runBlocking {
        val h = Harness()
        val other = Uuid.parse("11111111-2222-3333-4444-555555555555")
        assertEquals(HarnessGate.CLOSED, h.binder.bind(other))
        assertFalse(h.binder.isBound(other))
        assertNull(h.gateway.listener)
    }

    @Test
    fun `unbind clears the gate, the live turn and the socket`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.resync()
        h.listener.onEvent(HarnessEvent.AssistantDelta(sessionId, "streaming"))
        assertTrue(h.binder.liveFlow(conversationId).value?.isBusy == true)

        h.binder.unbind(conversationId)
        assertFalse(h.binder.isBound(conversationId))
        assertEquals(HarnessGate.CLOSED, h.binder.gateFlow(conversationId).value)
        assertNull(h.binder.liveFlow(conversationId).value)
        assertTrue(h.gateway.subscription.closed)
        // The last paint drops the half-streamed bubble rather than persisting it.
        assertNull(h.renders.last().live)
    }

    @Test
    fun `unbindAll detaches every thread - the node-switch path`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        assertTrue(h.binder.isBound(conversationId))
        h.binder.unbindAll()
        assertFalse(h.binder.isBound(conversationId))
        assertTrue(h.gateway.subscription.closed)
    }

    // ---- M2: the fatal path --------------------------------------------------

    @Test
    fun `a fatal stream clears the gate and the live turn so the composer frees`() =
        runBlocking {
            val h = Harness()
            h.binder.bind(conversationId)
            h.resync()
            h.listener.onEvent(HarnessEvent.AssistantDelta(sessionId, "half a reply"))
            assertTrue(h.binder.liveFlow(conversationId).value?.isBusy == true)

            h.listener.onEvent(
                HarnessEvent.Error(sessionId, "capability_unsupported", "no live stream", false),
            )

            // Every one of these was stale before the fix: the binding went, but
            // the live turn kept the spinner up, the gate kept Stop on screen,
            // and `stream = true` kept the legacy poll suppressed forever.
            assertFalse(h.binder.isBound(conversationId))
            assertNull(h.binder.liveFlow(conversationId).value)
            assertEquals(HarnessGate.CLOSED, h.binder.gateFlow(conversationId).value)
            assertFalse(h.binder.gateFlow(conversationId).value.stream)
            assertEquals(listOf("no live stream"), h.surfaced)
        }

    @Test
    fun `a refused handshake is terminal and reported once`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.listener.onTerminal("not authorized for this node's harness stream (401)")

        assertFalse(h.binder.isBound(conversationId))
        assertEquals(HarnessGate.CLOSED, h.binder.gateFlow(conversationId).value)
        assertEquals(1, h.surfaced.size)
        assertTrue(h.surfaced.single().contains("401"))
    }

    @Test
    fun `a 401 on the transcript is fatal, not a silent retry`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.gateway.transcriptFailure = HarnessHttpException(401, null, "unauthorized", null)

        h.resync()

        // Auth used to sit in the retryable bucket: logged, never surfaced, and
        // the thread stayed "bound" over a stream that would never speak.
        assertFalse(h.binder.isBound(conversationId))
        assertEquals(HarnessGate.CLOSED, h.binder.gateFlow(conversationId).value)
        assertEquals(listOf("unauthorized"), h.surfaced)
    }

    @Test
    fun `a 503 on the transcript keeps the thread bound`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.gateway.transcriptFailure = HarnessHttpException(503, null, "restarting", true)

        h.resync()

        assertTrue(h.binder.isBound(conversationId))
        assertTrue(h.surfaced.isEmpty())
    }

    // ---- M1: the send queue --------------------------------------------------

    @Test
    fun `turns are sent strictly in order, one at a time`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.resync()

        h.binder.send(conversationId, "first")
        h.binder.send(conversationId, "second")
        h.binder.send(conversationId, "third")

        assertEquals(listOf("first", "second", "third"), h.gateway.sent)
        assertEquals(listOf("first", "second", "third"), h.renders.last().pendingUser)
    }

    @Test
    fun `a turn_in_flight head is retried and nothing overtakes it`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.resync()
        // First two attempts at "first" are refused; "second" must wait.
        h.gateway.sendFailures.addLast(busy())
        h.gateway.sendFailures.addLast(busy())

        h.binder.send(conversationId, "first")
        h.binder.send(conversationId, "second")

        assertEquals(listOf("first", "second"), h.gateway.sent)
        // Two backoffs consumed by the head, doubling — not one pump abandoned
        // by the next, which is what a job-per-turn did.
        assertEquals(listOf(1_500L, 3_000L), h.slept)
    }

    @Test
    fun `past the retry cap the turn stays queued and says so once`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.resync()
        repeat(HarnessTurnPolicyAttempts + 1) { h.gateway.sendFailures.addLast(busy()) }

        h.binder.send(conversationId, "stubborn")

        assertTrue(h.gateway.sent.isEmpty())
        assertEquals(listOf("stubborn"), h.renders.last().pendingUser)
        assertEquals(1, h.surfaced.size)
        assertTrue(h.surfaced.single().contains("queued"))
    }

    @Test
    fun `a refused turn is dropped and surfaced, and the queue keeps draining`() =
        runBlocking {
            val h = Harness()
            h.binder.bind(conversationId)
            h.resync()
            h.gateway.sendFailures.addLast(
                HarnessHttpException(501, "capability_unsupported", "no attachments", null),
            )

            h.binder.send(conversationId, "doomed")
            h.binder.send(conversationId, "fine")

            assertEquals(listOf("fine"), h.gateway.sent)
            assertEquals(listOf("fine"), h.renders.last().pendingUser)
            assertEquals(listOf("no attachments"), h.surfaced)
        }

    // ---- M1: one-shot retirement ---------------------------------------------

    @Test
    fun `one commit retires exactly one of two identical queued turns`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.resync()

        h.binder.send(conversationId, "ok")
        h.binder.send(conversationId, "ok")
        assertEquals(listOf("ok", "ok"), h.renders.last().pendingUser)

        // The harness commits the first one only.
        h.gateway.commitUser("ok")
        h.resync()
        // `contains()` retired both here — the bug this test exists for.
        assertEquals(listOf("ok"), h.renders.last().pendingUser)

        h.gateway.commitUser("ok")
        h.resync()
        assertTrue(h.renders.last().pendingUser.isEmpty())
    }

    @Test
    fun `a queued turn matching old history is not retired by it`() = runBlocking {
        val h = Harness()
        // The thread already contains "ok" from long ago.
        h.gateway.commitUser("ok")
        h.binder.bind(conversationId)
        h.resync()

        h.binder.send(conversationId, "ok")
        assertEquals(listOf("ok"), h.renders.last().pendingUser)

        // A resync that adds nothing new must not retire the pending turn.
        h.resync()
        assertEquals(listOf("ok"), h.renders.last().pendingUser)

        h.gateway.commitUser("ok")
        h.resync()
        assertTrue(h.renders.last().pendingUser.isEmpty())
    }

    @Test
    fun `an unsent turn is never retired by a commit`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.resync()
        // Park the head so "queued" never leaves the queue.
        repeat(HarnessTurnPolicyAttempts + 1) { h.gateway.sendFailures.addLast(busy()) }
        h.binder.send(conversationId, "queued")

        h.gateway.commitUser("queued")
        h.resync()
        assertEquals(listOf("queued"), h.renders.last().pendingUser)
    }

    // ---- M1: the ghost turn --------------------------------------------------

    @Test
    fun `an accepted turn that never commits is reaped and reported`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.resync()
        h.binder.send(conversationId, "into the void")
        assertEquals(listOf("into the void"), h.renders.last().pendingUser)

        // Well inside the grace: still shown, nothing said.
        h.now += HarnessChatBinder.GHOST_GRACE_MS / 2
        h.resync()
        assertEquals(listOf("into the void"), h.renders.last().pendingUser)
        assertTrue(h.surfaced.isEmpty())

        h.now += HarnessChatBinder.GHOST_GRACE_MS
        h.resync()
        assertTrue(h.renders.last().pendingUser.isEmpty())
        assertEquals(1, h.surfaced.size)
        assertTrue(h.surfaced.single().contains("never recorded"))
    }

    @Test
    fun `a long quiet turn is not a ghost while something is streaming`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.resync()
        h.binder.send(conversationId, "big job")
        h.listener.onEvent(HarnessEvent.AssistantDelta(sessionId, "working on it"))

        h.now += HarnessChatBinder.GHOST_GRACE_MS * 3
        // A bare resync, not a reopen: `onOpen` clears the live turn by
        // contract, and the point here is that a streaming turn protects its
        // own pending message from the reaper.
        h.binder.resync(conversationId)

        assertTrue(h.surfaced.isEmpty())
        assertEquals(listOf("big job"), h.renders.last().pendingUser)
    }

    // ---- interrupt gating ----------------------------------------------------

    @Test
    fun `interrupt is refused when the driver has none`() = runBlocking {
        val h = Harness(
            capabilities = HarnessCapabilities(
                interrupt = false,
                resume = true,
                approvals = false,
                liveStream = true,
                listSessions = true,
            ),
        )
        h.binder.bind(conversationId)
        h.binder.interrupt(conversationId)
        assertEquals(0, h.gateway.interrupts)
    }

    @Test
    fun `interrupt clears the live turn when the driver has one`() = runBlocking {
        val h = Harness()
        h.binder.bind(conversationId)
        h.resync()
        h.listener.onEvent(HarnessEvent.AssistantDelta(sessionId, "half"))

        h.binder.interrupt(conversationId)
        assertEquals(1, h.gateway.interrupts)
        assertNull(h.binder.liveFlow(conversationId).value)
    }

    @Test
    fun `interrupt on an unbound thread is a no-op`() = runBlocking {
        val h = Harness()
        h.binder.interrupt(conversationId)
        assertEquals(0, h.gateway.interrupts)
    }

    // ---- render composition --------------------------------------------------

    @Test
    fun `a render is transcript then pending then live`() = runBlocking {
        val h = Harness(scheduler = ImmediateScheduler())
        h.gateway.commitUser("older")
        h.binder.bind(conversationId)
        h.resync()
        h.binder.send(conversationId, "queued")
        h.listener.onEvent(HarnessEvent.AssistantDelta(sessionId, "replying"))

        val render = h.renders.last()
        assertEquals(listOf("older"), render.turns.map { it.text })
        assertEquals(listOf("queued"), render.pendingUser)
        assertEquals("replying", render.live?.text)
        assertEquals("claude", render.harnessCommand)
    }

    private companion object {
        /** Mirrors HarnessTurnPolicy.RETRY_ATTEMPTS. */
        const val HarnessTurnPolicyAttempts = 6
    }
}

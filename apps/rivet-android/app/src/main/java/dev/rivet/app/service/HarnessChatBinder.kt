package dev.rivet.app.service

import android.util.Log
import dev.rivet.app.data.harness.HarnessAttachSink
import dev.rivet.app.data.harness.HarnessAttachment
import dev.rivet.app.data.harness.HarnessChatRow
import dev.rivet.app.data.harness.HarnessEvent
import dev.rivet.app.data.harness.HarnessGate
import dev.rivet.app.data.harness.HarnessPlaneSource
import dev.rivet.app.data.harness.HarnessScheduler
import dev.rivet.app.data.harness.HarnessSessionGateway
import dev.rivet.app.data.harness.HarnessTranscriptTurn
import dev.rivet.app.data.harness.HarnessTurnPolicy
import dev.rivet.app.data.harness.LiveTurn
import dev.rivet.app.data.harness.TurnOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.CoroutineContext
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * Binds one open chat thread to a driver-owned harness session.
 *
 * Per session, not per app: a row a registered driver claims streams on
 * `WS /api/harness-sessions/ws`, hard-resyncs its transcript on every open (the
 * tail has no replay) and sends through `sendUserTurn`. Rows no driver claims
 * keep the existing `/v1` provider binding verbatim, so nothing disappears and
 * nothing changes for them — there is no user-facing toggle and no legacy mode
 * to pick.
 *
 * What renders is always `transcript + pending user turns + the live turn`:
 * the transcript is the source of truth and is replaced wholesale on every
 * resync, so a locally-typed turn the harness has not committed yet has to be
 * carried alongside rather than merged in, or a resync would eat it.
 *
 * Every collaborator is injected — the plane, the clock, the sleep, the log —
 * because the ordering rules below (one sender at a time, one-shot retirement,
 * fatal-clears-everything) are exactly the kind of thing that only stays true
 * if a test is holding it there.
 */
@OptIn(ExperimentalUuidApi::class)
class HarnessChatBinder(
    private val scope: CoroutineScope,
    private val plane: HarnessPlaneSource,
    /** Paint the thread. Conflated: a slow write is cancelled by a newer one. */
    private val render: suspend (Uuid, HarnessRender) -> Unit,
    /** Something the user needs to know: a refused turn, a dead stream. */
    private val onFatal: (Uuid, String) -> Unit = { _, _ -> },
    private val scheduler: HarnessScheduler = HarnessScheduler.REAL,
    /** Where blocking calls run. Tests inherit the caller's for determinism. */
    private val io: CoroutineContext = Dispatchers.IO,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val log: (String) -> Unit = { Log.i(TAG, it) },
) {
    private val bindings = ConcurrentHashMap<Uuid, Binding>()
    private val liveFlows = ConcurrentHashMap<Uuid, MutableStateFlow<LiveTurn?>>()
    private val gateFlows = ConcurrentHashMap<Uuid, MutableStateFlow<HarnessGate>>()
    private val turnIds = AtomicLong(0)

    /** True while the control plane owns this thread's send/stream path. */
    fun isBound(conversationId: Uuid): Boolean = bindings.containsKey(conversationId)

    /**
     * This thread's capabilities, as a flow.
     *
     * A one-shot snapshot is the wrong shape: a stream that dies terminally
     * un-binds the thread, and a caller holding a stale `bound = true` would
     * keep suppressing the legacy poll and keep offering a Stop button that
     * has nothing left to stop.
     */
    fun gateFlow(conversationId: Uuid): StateFlow<HarnessGate> =
        gateFlows.computeIfAbsent(conversationId) { MutableStateFlow(HarnessGate.CLOSED) }
            .asStateFlow()

    /**
     * The turn in flight, for the composer's Stop affordance. Emits null on an
     * unbound thread, so a caller can collect it unconditionally.
     */
    fun liveFlow(conversationId: Uuid): StateFlow<LiveTurn?> =
        liveFlows.computeIfAbsent(conversationId) { MutableStateFlow(null) }.asStateFlow()

    fun gate(conversationId: Uuid): HarnessGate =
        gateFlows[conversationId]?.value ?: HarnessGate.CLOSED

    /** Canonical `<harness-id>:<native>` for a bound thread. */
    fun sessionId(conversationId: Uuid): String? = bindings[conversationId]?.sessionId

    fun live(conversationId: Uuid): LiveTurn? = liveFlows[conversationId]?.value

    /**
     * Attach [conversationId] if a registered driver claims its row.
     *
     * Returns the gate: [HarnessGate.CLOSED] means "not ours" and the caller
     * keeps every legacy behavior, including the transcript poll.
     */
    suspend fun bind(conversationId: Uuid): HarnessGate {
        bindings[conversationId]?.let { return it.gate }
        val snapshot = plane.snapshot()
        val row = snapshot.rows.firstOrNull { candidate ->
            ChatService.parseHarnessSessionUuid(candidate.key) == conversationId
        } ?: return HarnessGate.CLOSED
        val gate = snapshot.gate(row.key)
        if (!gate.bound) return HarnessGate.CLOSED
        val sessionId = row.sessionId ?: return HarnessGate.CLOSED
        val gateway = plane.gateway() ?: return HarnessGate.CLOSED

        val binding = Binding(conversationId, sessionId, row, gate, gateway)
        // Losing a race means another caller already attached this thread; the
        // loser must not leave a second socket tailing the same session.
        val existing = bindings.putIfAbsent(conversationId, binding)
        if (existing != null) return existing.gate
        gateFlows.computeIfAbsent(conversationId) { MutableStateFlow(HarnessGate.CLOSED) }.value =
            gate
        binding.start()
        log("bound $conversationId to $sessionId (${row.harnessId})")
        return gate
    }

    /**
     * Detach and cancel everything: the socket, a pending settle, the send
     * pump, and — the part a fatal stream must not skip — the live turn and the
     * gate, or the composer is left spinning on a thread nothing will ever
     * update again.
     */
    fun unbind(conversationId: Uuid) {
        val binding = bindings.remove(conversationId)
        gateFlows[conversationId]?.value = HarnessGate.CLOSED
        liveFlows[conversationId]?.value = null
        binding?.stop()
    }

    /** Detach every thread — node switch, sign-out. */
    fun unbindAll() {
        bindings.keys.toList().forEach { unbind(it) }
    }

    /**
     * Queue a user turn. Turns are sent strictly in order, one at a time:
     * `turn_in_flight` is not a failure (v1 drivers never queue), so the head
     * is retried on a bounded backoff while everything behind it waits rather
     * than racing past it.
     */
    suspend fun send(conversationId: Uuid, text: String): Boolean {
        val binding = bindings[conversationId] ?: return false
        binding.enqueue(text)
        return true
    }

    /** Cancel the in-flight turn. No-op unless the driver reports `interrupt`. */
    suspend fun interrupt(conversationId: Uuid) {
        val binding = bindings[conversationId] ?: return
        if (!binding.gate.canInterrupt) return
        withContext(io) {
            runCatching { binding.gateway.interrupt(binding.sessionId) }
                .onFailure { log("interrupt failed: ${it.message}") }
        }
        binding.clearLive()
    }

    /** Force a hard resync from the transcript (menu Resync, ON_RESUME). */
    fun resync(conversationId: Uuid) {
        bindings[conversationId]?.attachment?.resync()
    }

    /**
     * One turn the user typed here, waiting for the harness store to record it.
     *
     * [baseline] is how many user turns the transcript already carried when
     * this was queued — the floor for matching it against a committed turn, so
     * two identical texts cannot both be retired by one commit.
     */
    private class PendingTurn(val id: Long, val text: String, var baseline: Int) {
        var attempts = 0

        /** Epoch ms the driver accepted it, or 0 while it is still queued. */
        var sentAtMs = 0L
    }

    private inner class Binding(
        val conversationId: Uuid,
        val sessionId: String,
        val row: HarnessChatRow,
        val gate: HarnessGate,
        val gateway: HarnessSessionGateway,
    ) {
        private val liveState =
            liveFlows.computeIfAbsent(conversationId) { MutableStateFlow(null) }

        var live: LiveTurn?
            get() = liveState.value
            private set(value) {
                liveState.value = value
            }

        @Volatile
        private var turns: List<HarnessTranscriptTurn> = emptyList()

        private val pending = ArrayList<PendingTurn>()

        /**
         * Latest thread state. Collected with `collectLatest`, so a burst of
         * deltas costs one Room write of the newest state rather than one write
         * per delta racing each other to last-write-wins.
         */
        private val renderState = MutableStateFlow<HarnessRender?>(null)

        private var renderJob: Job? = null
        private var pumpJob: Job? = null

        var attachment: HarnessAttachment? = null
            private set

        fun start() {
            renderJob = scope.launch {
                renderState.filterNotNull().collectLatest { render(conversationId, it) }
            }
            attachment = HarnessAttachment.open(
                gateway = gateway,
                sessionId = sessionId,
                sink = Sink(),
                scheduler = scheduler,
                runResync = { work -> scope.launch(io) { work() } },
            )
        }

        fun stop() {
            pumpJob?.cancel()
            pumpJob = null
            attachment?.close()
            attachment = null
            // Final paint on the parent scope, not the child that is about to
            // die: leaving mid-turn must not persist a half-streamed bubble.
            live = null
            val last = snapshot()
            renderJob?.cancel()
            renderJob = null
            scope.launch { render(conversationId, last) }
        }

        fun clearLive() {
            live = null
            paint()
        }

        fun enqueue(text: String) {
            synchronized(pending) {
                pending.add(
                    PendingTurn(
                        id = turnIds.incrementAndGet(),
                        text = text,
                        baseline = turns.count { it.role == "user" },
                    ),
                )
            }
            paint()
            ensurePump()
        }

        /**
         * One sender per thread. A second call while the pump is alive is a
         * no-op — the new turn is already in the queue and the running drain
         * will reach it, which is the whole point of a drain loop over a job
         * per turn (a per-turn job would let turn 2 overtake a turn 1 sitting
         * in `turn_in_flight` backoff).
         */
        private fun ensurePump() {
            if (pumpJob?.isActive == true) return
            pumpJob = scope.launch(io) { drain() }
        }

        private suspend fun drain() {
            while (true) {
                val next = synchronized(pending) { pending.firstOrNull { it.sentAtMs == 0L } }
                    ?: return
                val error = runCatching { gateway.sendTurn(sessionId, next.text) }.exceptionOrNull()
                when (val outcome = HarnessTurnPolicy.classify(error, next.attempts)) {
                    is TurnOutcome.Sent -> {
                        next.sentAtMs = nowMs()
                        // The tail and the next resync own it from here.
                    }

                    is TurnOutcome.Retry -> {
                        next.attempts = outcome.attempt
                        log(
                            "turn_in_flight on $sessionId — retry ${outcome.attempt} " +
                                "in ${outcome.delayMs}ms",
                        )
                        sleep(outcome.delayMs)
                    }

                    is TurnOutcome.Parked -> {
                        // Left queued deliberately: a harness sitting on its own
                        // TUI permission prompt is mid-turn until a human
                        // answers, and polling it forever helps nobody. The
                        // next send re-arms the pump.
                        log("turn_in_flight on $sessionId past the retry cap — left queued")
                        surface(
                            "The harness is still busy — your message is queued. " +
                                "Send again to retry.",
                        )
                        return
                    }

                    is TurnOutcome.Failed -> {
                        // A refused turn is gone: leaving its bubble would
                        // claim the harness has it.
                        drop(next)
                        surface(outcome.error.message ?: "the harness refused this turn")
                    }
                }
            }
        }

        private fun drop(turn: PendingTurn) {
            synchronized(pending) { pending.removeAll { it.id == turn.id } }
            paint()
        }

        private fun surface(message: String) {
            log("turn problem on $sessionId: $message")
            onFatal(conversationId, message)
        }

        /**
         * Retire pending turns the transcript now carries — in queue order,
         * one commit per turn.
         *
         * `contains()` is wrong here twice over: two identical queued texts
         * would both be retired by a single commit, and a text matching some
         * long-past turn would retire a turn the harness never took. So each
         * pending turn may only match a committed turn at or after its own
         * baseline, and a match advances the baseline of everything behind it.
         */
        private fun retirePending(committed: List<HarnessTranscriptTurn>) {
            val userTexts = committed.filter { it.role == "user" }.map { it.text.trim() }
            synchronized(pending) {
                if (pending.isEmpty()) return
                var cursor = 0
                val iterator = pending.iterator()
                while (iterator.hasNext()) {
                    val turn = iterator.next()
                    // Strict FIFO: nothing behind an unsent turn can have
                    // committed, so the scan stops here.
                    if (turn.sentAtMs == 0L) break
                    cursor = maxOf(cursor, turn.baseline)
                    val hit = (cursor until userTexts.size)
                        .firstOrNull { userTexts[it] == turn.text.trim() }
                        ?: break
                    iterator.remove()
                    cursor = hit + 1
                }
                // Whatever is left can only match strictly later commits now.
                pending.forEach { it.baseline = maxOf(it.baseline, cursor) }
            }
        }

        /**
         * A turn the driver accepted that never showed up in the store.
         *
         * Only checked on a resync and only while nothing is streaming: a long
         * quiet turn is still a turn. Past the grace the bubble is dropped and
         * said out loud, because a phantom user message that survives every
         * resync is worse than an honest "that did not land".
         */
        private fun reapGhosts() {
            if (live?.isBusy == true) return
            val now = nowMs()
            val ghosts = synchronized(pending) {
                val dead = pending.filter {
                    it.sentAtMs != 0L && now - it.sentAtMs > GHOST_GRACE_MS
                }
                pending.removeAll(dead.toSet())
                dead
            }
            if (ghosts.isEmpty()) return
            paint()
            surface(
                "The harness accepted ${ghosts.size} message(s) but never recorded them. " +
                    "They were not delivered.",
            )
        }

        private fun snapshot(): HarnessRender = HarnessRender(
            turns = turns,
            pendingUser = synchronized(pending) { pending.map { it.text } },
            live = live,
            harnessCommand = row.command,
        )

        private fun paint() {
            renderState.value = snapshot()
        }

        private inner class Sink : HarnessAttachSink {
            override fun onTranscript(turns: List<HarnessTranscriptTurn>) {
                this@Binding.turns = turns
                retirePending(turns)
                reapGhosts()
                paint()
            }

            override fun onLive(turn: LiveTurn?) {
                live = turn
                paint()
            }

            override fun onApproval(event: HarnessEvent) {
                // claude-code and grok-build both report approvals:false, so no
                // driver can reach this yet. Recorded, not rendered: a card the
                // user could not answer would be worse than none, and the
                // contract has no way to recover a pending approval after a
                // reconnect anyway (Phase 3 driver requirement).
                log("approval event on $sessionId: $event")
            }

            override fun onError(err: Throwable) {
                log("resync failed on $sessionId: ${err.message}")
            }

            override fun onFatal(message: String) {
                log("attachment fatal on $sessionId: $message")
                // Through unbind, never by hand: the gate has to fall back to
                // CLOSED and the live turn has to clear, or the thread keeps a
                // Stop button over a dead socket and never resumes the legacy
                // poll that would at least still show new turns.
                unbind(conversationId)
                this@HarnessChatBinder.onFatal(conversationId, message)
            }
        }
    }

    companion object {
        private const val TAG = "HarnessChatBinder"

        /** How long an accepted turn may stay missing from the store. */
        const val GHOST_GRACE_MS = 120_000L
    }
}

/** Everything a bound thread should be showing right now. */
data class HarnessRender(
    /** Committed turns — replaced wholesale on every hard resync. */
    val turns: List<HarnessTranscriptTurn>,
    /** Typed here, not yet in the store (queued or mid-`turn_in_flight`). */
    val pendingUser: List<String>,
    /** The turn in flight, or null. */
    val live: LiveTurn?,
    /** Den roster command, for the model badge. */
    val harnessCommand: String?,
)

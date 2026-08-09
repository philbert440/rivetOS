package dev.rivet.app.data.harness

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Attach one chat view to a driver-owned harness session. Kotlin twin of
 * `apps/rivethub-web/src/lib/harness-attach.ts`.
 *
 * The contract's stream rule drives every line here: `subscribe` is an
 * at-most-once live tail from attach time — no replay buffer, no sequence
 * numbers — so a client that reconnects and picks up the tail has silently lost
 * whatever happened during the gap. The only correct recovery is a hard resync
 * from the transcript source of truth. This therefore resyncs on EVERY open,
 * first connect and reconnect alike, and never folds across a gap.
 *
 * It also resyncs after `turn-complete`: the live tail carries text and tool
 * calls, but the committed turn text, thinking and usage come from the store.
 *
 * Framework-free on purpose — the caller supplies the sinks and the scheduler,
 * so the reconnect/resync ordering is unit-testable without a socket.
 */

/** The slice of the client an attachment needs; also the test seam. */
interface HarnessAttachGateway {
    fun transcript(sessionId: String): HarnessTranscript
    fun watchSession(sessionId: String, listener: HarnessStreamListener): HarnessSubscription
}

/**
 * Deferred work (the post-turn settle). Injectable so tests run instantly.
 * [HarnessCancellable] lives in `HarnessSocket.kt` beside the reconnect timer
 * that also uses it.
 */
interface HarnessScheduler {
    /** Run [task] after [delayMs]; the handle cancels it if it has not fired. */
    fun schedule(delayMs: Long, task: () -> Unit): HarnessCancellable

    companion object {
        /** Shared daemon timer — one for every attachment in the process. */
        val REAL: HarnessScheduler = object : HarnessScheduler {
            private val exec = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
                Thread(r, "harness-attach").apply { isDaemon = true }
            }

            override fun schedule(delayMs: Long, task: () -> Unit): HarnessCancellable {
                val future = exec.schedule(task, delayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                return HarnessCancellable { future.cancel(false) }
            }
        }
    }
}

/** Sinks an attachment writes into. */
interface HarnessAttachSink {
    /** Hard resync — replaces the transcript wholesale. Never merges. */
    fun onTranscript(turns: List<HarnessTranscriptTurn>)

    /** Live turn state; null clears the slot. */
    fun onLive(turn: LiveTurn?)

    /** Approval request/resolution — outlives the turn, so not part of the fold. */
    fun onApproval(event: HarnessEvent) {}

    /** Transient resync failure (node offline, node restarting). */
    fun onError(err: Throwable) {}

    /**
     * The session cannot be attached at all — deleted, unknown to the registry,
     * or a driver that cannot serve this stream. The attachment has already
     * stopped itself: no reconnect loop against a session that will never
     * answer.
     */
    fun onFatal(message: String) {}

    /** Socket lifecycle, for a connection banner. */
    fun onStatus(open: Boolean) {}
}

/**
 * A live attachment. [resync] forces a hard resync (returning to the chat from
 * another screen, a manual refresh); [close] releases everything silently.
 */
class HarnessAttachment private constructor(
    private val gateway: HarnessAttachGateway,
    private val sessionId: String,
    private val sink: HarnessAttachSink,
    private val scheduler: HarnessScheduler,
    private val settleMs: Long,
    /** Runs the blocking transcript read off the caller's thread. */
    private val runResync: (() -> Unit) -> Unit,
) {
    private val closed = AtomicBoolean(false)

    /** Bumped per resync so a slow in-flight read cannot overwrite a newer one. */
    private val generation = AtomicInteger(0)

    private var live: LiveTurn? = null
    private var settle: HarnessCancellable? = null
    private var subscription: HarnessSubscription? = null

    private fun start() {
        subscription = gateway.watchSession(
            sessionId,
            object : HarnessStreamListener {
                override fun onOpen() {
                    if (closed.get()) return
                    sink.onStatus(true)
                    // Fresh attach (first or Nth): everything between the drop
                    // and now is gone from the tail forever. Drop the live turn
                    // and rebuild from the transcript — the hard-resync rule.
                    //
                    // Unconditionally, not only when WE folded one: a bubble
                    // showing on open may predate this attachment, and with no
                    // replay nothing will ever supersede it.
                    setLive(null)
                    resync()
                }

                override fun onEvent(event: HarnessEvent) {
                    if (closed.get()) return
                    if (event is HarnessEvent.ApprovalRequest ||
                        event is HarnessEvent.ApprovalResolved
                    ) {
                        sink.onApproval(event)
                        return
                    }
                    if (event is HarnessEvent.Error && isFatalFrame(event)) {
                        // The server's attach-failure frame: it closes the
                        // socket right after, and the reconnecting client would
                        // otherwise loop into the same refusal forever, each
                        // round trip re-arming a 404 resync.
                        fatal(event.message.ifBlank { event.code })
                        return
                    }
                    val next = HarnessFold.fold(live, event)
                    if (next !== live) setLive(next)
                    if (event is HarnessEvent.TurnComplete) {
                        // The committed turn lands on disk as it commits, and
                        // `turn-complete` can beat the last flush — read it
                        // back after a grace rather than trusting the tail.
                        settle?.cancel()
                        settle = scheduler.schedule(settleMs) { resync() }
                    }
                }

                override fun onClosed() {
                    if (closed.get()) return
                    sink.onStatus(false)
                }

                override fun onTerminal(message: String) {
                    // A refused handshake (wrong bearer, route not mounted).
                    // The socket already stopped; say so once instead of
                    // leaving a thread that looks connected and never speaks.
                    fatal(message)
                }
            },
        )
    }

    /** Force a hard resync from the transcript source of truth. */
    fun resync() {
        if (closed.get()) return
        val mine = generation.incrementAndGet()
        runResync {
            if (closed.get() || mine != generation.get()) return@runResync
            val result = runCatching { gateway.transcript(sessionId) }
            if (closed.get() || mine != generation.get()) return@runResync
            result.fold(
                onSuccess = { sink.onTranscript(it.turns) },
                onFailure = { err ->
                    if (HarnessPlane.isFatal(err)) {
                        fatal(fatalMessage(err))
                    } else {
                        sink.onError(err)
                    }
                },
            )
        }
    }

    /** Release every resource without reporting anything. */
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        settle?.cancel()
        settle = null
        subscription?.close()
        subscription = null
    }

    private fun setLive(turn: LiveTurn?) {
        live = turn
        sink.onLive(turn)
    }

    /** Stop for good — a session that will never answer must not be retried. */
    private fun fatal(message: String) {
        if (closed.get()) return
        close()
        sink.onFatal(message)
    }

    private fun isFatalFrame(event: HarnessEvent.Error): Boolean =
        event.code == "invalid_session_id" || event.code == "capability_unsupported"

    private fun fatalMessage(err: Throwable): String {
        val e = err as? HarnessHttpException
        val message = e?.message.orEmpty()
        return message.ifBlank { "transcript unavailable (${e?.status ?: 0})" }
    }

    companion object {
        /**
         * Grace before the post-turn resync: the harness store is written as
         * the turn commits, and `turn-complete` can beat the last flush.
         */
        const val DEFAULT_SETTLE_MS = 400L

        /**
         * Open an attachment. It subscribes immediately; the first hard resync
         * is triggered by the socket's own `open`, so a node that never answers
         * never blanks the thread with an empty transcript.
         */
        fun open(
            gateway: HarnessAttachGateway,
            sessionId: String,
            sink: HarnessAttachSink,
            scheduler: HarnessScheduler = HarnessScheduler.REAL,
            settleMs: Long = DEFAULT_SETTLE_MS,
            runResync: (() -> Unit) -> Unit,
        ): HarnessAttachment = HarnessAttachment(
            gateway,
            sessionId,
            sink,
            scheduler,
            settleMs,
            runResync,
        ).also { it.start() }
    }
}

package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessTranscriptTurn
import io.rivethub.app.gateway.isFatalHarnessEvent
import io.rivethub.app.gateway.isFatalTranscriptError

const val IDLE_DEADLINE_MS: Long = 3 * 60_000L

/**
 * Grace before the post-turn transcript fetch: the harness store is written
 * as the turn commits, and `turn-complete` can beat the last flush to disk.
 * Twin of `DEFAULT_SETTLE_MS` in rivethub-web `harness-attach.ts`.
 */
const val RESYNC_SETTLE_MS: Long = 400L

enum class FrameVerdict { Continue, Fatal }

/**
 * Transcript state machine for one harness session.
 *
 * Not thread-safe; confine to a single dispatcher (the ViewModel's), and
 * marshal WS frames onto it before calling [onFrame].
 *
 * The live tail is at-most-once from attach time, so [onOpen] and
 * [onTurnComplete] REPLACE the transcript wholesale (a merge would
 * duplicate). [onFrame] appends deltas onto the live slot. The 3-minute
 * idle deadline is re-armed on every stream frame; [nowMs] is injected
 * so tests can drive the clock.
 */
class TranscriptMachine(
    private val nowMs: () -> Long,
    private val idleDeadlineMs: Long = IDLE_DEADLINE_MS,
) {
    var transcript: List<HarnessTranscriptTurn> = emptyList()
        private set
    var liveText: String = ""
        private set
    var liveReasoning: String = ""
        private set
    var inFlight: Boolean = false
        private set
    var turnStartTs: Long? = null
        private set
    var lastFrameTs: Long? = null
        private set

    fun beginTurn() {
        val t = nowMs()
        inFlight = true
        turnStartTs = t
        lastFrameTs = t
        liveText = ""
        liveReasoning = ""
    }

    /** Hard replace — never merge. Clears the live slot (reconnect = missed tail). */
    fun onOpen(fullTranscript: List<HarnessTranscriptTurn>) {
        transcript = fullTranscript.toList()
        liveText = ""
        liveReasoning = ""
    }

    fun onFrame(event: HarnessEvent): FrameVerdict {
        lastFrameTs = nowMs()
        if (isFatalHarnessEvent(event)) {
            inFlight = false
            return FrameVerdict.Fatal
        }
        when (event) {
            is HarnessEvent.AssistantDelta -> {
                liveText += event.text
                if (!inFlight) {
                    inFlight = true
                    if (turnStartTs == null) turnStartTs = lastFrameTs
                }
            }
            is HarnessEvent.ReasoningDelta -> {
                liveReasoning += event.text
                if (!inFlight) {
                    inFlight = true
                    if (turnStartTs == null) turnStartTs = lastFrameTs
                }
            }
            is HarnessEvent.ToolUse, is HarnessEvent.ToolResult -> {
                if (!inFlight) {
                    inFlight = true
                    if (turnStartTs == null) turnStartTs = lastFrameTs
                }
            }
            is HarnessEvent.Error -> {
                inFlight = false
            }
            is HarnessEvent.TurnComplete -> {
                inFlight = false
            }
            else -> Unit
        }
        return FrameVerdict.Continue
    }

    /** Hard replace with the committed transcript. */
    fun onTurnComplete(fullTranscript: List<HarnessTranscriptTurn>) {
        transcript = fullTranscript.toList()
        liveText = ""
        liveReasoning = ""
        inFlight = false
        turnStartTs = null
        lastFrameTs = nowMs()
    }

    fun idleTimedOut(): Boolean {
        if (!inFlight) return false
        val last = lastFrameTs ?: turnStartTs ?: return false
        return nowMs() - last >= idleDeadlineMs
    }
}

/**
 * Owner of one session attach. Hard-resyncs from [fetchTranscript] on every
 * watch open and after turn-complete (after [RESYNC_SETTLE_MS]). Fatal error
 * frames and 400/404/410/501 on the transcript route stop the watch so it
 * cannot reconnect into a dead session.
 *
 * Not thread-safe; confine to a single dispatcher with [TranscriptMachine].
 */
class SessionAttach(
    val machine: TranscriptMachine,
    private val fetchTranscript: suspend () -> List<HarnessTranscriptTurn>,
    private val onFatal: (String) -> Unit = {},
    private val closeWatch: () -> Unit = {},
    val settleMs: Long = RESYNC_SETTLE_MS,
) {
    var stopped: Boolean = false
        private set
    private var generation: Int = 0
    private var settling: Boolean = false
    private val duringSettle = ArrayList<HarnessEvent>()

    /**
     * Retire this attach without closing the live watch or firing [onFatal].
     * A replacement attach owns the socket; a stale settle must not wipe it.
     */
    fun detach() {
        if (stopped) return
        stopped = true
        generation++
        settling = false
        duringSettle.clear()
    }

    suspend fun onWatchOpen() {
        if (stopped) return
        resync(committed = false)
    }

    /**
     * Apply [event] immediately. Turn-complete does **not** delay here —
     * the owner defers [flushCommittedResync] so later frames are not
     * queued behind the 400 ms settle.
     */
    suspend fun onFrame(event: HarnessEvent) {
        if (stopped) return
        val verdict = machine.onFrame(event)
        if (verdict == FrameVerdict.Fatal) {
            val err = event as HarnessEvent.Error
            stop(err.message.ifBlank { err.code })
            return
        }
        if (settling && event !is HarnessEvent.TurnComplete) {
            duringSettle += event
        }
        if (event is HarnessEvent.TurnComplete) {
            settling = true
            duringSettle.clear()
        }
    }

    /** After settleMs: hard-replace, then replay frames that arrived during settle. */
    suspend fun flushCommittedResync() {
        if (stopped || !settling) return
        resync(committed = true)
        if (stopped) return
        for (e in duringSettle.toList()) {
            if (stopped) return
            machine.onFrame(e)
        }
        duringSettle.clear()
        settling = false
    }

    private suspend fun resync(committed: Boolean) {
        val mine = ++generation
        try {
            val turns = fetchTranscript()
            if (stopped || mine != generation) return
            if (committed) machine.onTurnComplete(turns) else machine.onOpen(turns)
        } catch (e: Throwable) {
            if (stopped || mine != generation) return
            if (isFatalTranscriptError(e)) {
                val status = (e as? GatewayException)?.status
                val fallback = if (status != null) "transcript unavailable ($status)" else "transcript unavailable"
                stop(e.message?.takeIf { it.isNotBlank() } ?: fallback)
            }
        }
    }

    fun stop(message: String) {
        if (stopped) return
        stopped = true
        closeWatch()
        onFatal(message)
    }
}

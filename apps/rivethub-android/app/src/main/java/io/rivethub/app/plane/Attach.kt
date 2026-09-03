package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessTranscriptTurn
import io.rivethub.app.gateway.isFatalHarnessEvent
import io.rivethub.app.gateway.isFatalTranscriptError

const val IDLE_DEADLINE_MS: Long = 3 * 60_000L

/**
 * While a turn is in flight and the session WS is silent, poll the
 * committed transcript on this cadence until [IDLE_DEADLINE_MS].
 */
const val TRANSCRIPT_POLL_EVERY_MS: Long = 5_000L

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
    private var committed: List<HarnessTranscriptTurn> = emptyList()
    private val optimistic = ArrayList<HarnessTranscriptTurn>()

    /** Committed turns plus any unmatched optimistic user bubbles. */
    val transcript: List<HarnessTranscriptTurn>
        get() = if (optimistic.isEmpty()) committed else committed + optimistic
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
    /** True once a content session-WS frame arrived this turn (cancels silent poll). */
    var sawSessionFrame: Boolean = false
        private set
    /** Committed size at [beginTurn] — poll looks for an assistant past this. */
    var committedAtTurnStart: Int = 0
        private set
    /** Optimistic user text captured at [beginTurn]; resync completeness keys off this. */
    var pendingUserText: String? = null
        private set

    fun beginTurn() {
        val t = nowMs()
        inFlight = true
        turnStartTs = t
        lastFrameTs = t
        liveText = ""
        liveReasoning = ""
        sawSessionFrame = false
        committedAtTurnStart = committed.size
        pendingUserText = optimistic.lastOrNull { it.role.equals("user", ignoreCase = true) }?.text
    }

    /** Desktop `addOptimisticUser` — show the send immediately. */
    fun appendOptimisticUser(text: String) {
        if (text.isBlank()) return
        optimistic.add(HarnessTranscriptTurn(role = "user", text = text))
    }

    /** Send failed before inject/sendTurn landed — drop that bubble. */
    fun revertOptimisticUser(text: String) {
        val i = optimistic.indexOfLast { it.role.equals("user", ignoreCase = true) && it.text == text }
        if (i >= 0) optimistic.removeAt(i)
    }

    fun abortTurn() {
        inFlight = false
        liveText = ""
        liveReasoning = ""
        turnStartTs = null
        pendingUserText = null
    }

    /** Re-arm the idle deadline without clearing the live slot (adoption). */
    fun rearmIdle() {
        lastFrameTs = nowMs()
    }

    /** Hard replace — never merge. Clears the live slot (reconnect = missed tail). */
    fun onOpen(fullTranscript: List<HarnessTranscriptTurn>) {
        committed = fullTranscript.toList()
        consumeOptimistic(fullTranscript)
        liveText = ""
        liveReasoning = ""
    }

    fun onFrame(event: HarnessEvent): FrameVerdict {
        lastFrameTs = nowMs()
        if (sessionFrameCancelsPoll(event)) sawSessionFrame = true
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
        committed = fullTranscript.toList()
        consumeOptimistic(fullTranscript)
        liveText = ""
        liveReasoning = ""
        inFlight = false
        turnStartTs = null
        lastFrameTs = nowMs()
        pendingUserText = null
    }

    /**
     * Apply a silent-poll / registry fetch. [complete] means an assistant
     * turn is on disk after the pending user (or a turn-complete frame);
     * otherwise keep inFlight and only fold committed + optimistic.
     */
    fun applyFetched(turns: List<HarnessTranscriptTurn>, complete: Boolean) {
        if (complete) onTurnComplete(turns)
        else {
            committed = turns.toList()
            consumeOptimistic(turns)
        }
    }

    fun idleTimedOut(): Boolean {
        if (!inFlight) return false
        val last = lastFrameTs ?: turnStartTs ?: return false
        return nowMs() - last >= idleDeadlineMs
    }

    /**
     * Newest-match consume (desktop `transcriptPatch`): a committed user
     * turn retires one optimistic bubble of the same text.
     */
    private fun consumeOptimistic(fetched: List<HarnessTranscriptTurn>) {
        if (optimistic.isEmpty()) return
        val remainingUser = fetched.mapNotNull { t ->
            t.text.takeIf { t.role.equals("user", ignoreCase = true) }
        }.toMutableList()
        val kept = ArrayList<HarnessTranscriptTurn>(optimistic.size)
        for (bubble in optimistic) {
            val hit = remainingUser.lastIndexOf(bubble.text)
            if (hit >= 0) remainingUser.removeAt(hit)
            else kept.add(bubble)
        }
        optimistic.clear()
        optimistic.addAll(kept)
    }
}

/** Quiet statuses: the driver has no turn in flight. */
fun registryStatusIsQuiet(status: String?): Boolean =
    status == "idle" || status == "ended"

data class RegistryStamp(val status: String?, val updatedAt: String?)

fun registryStamp(event: HarnessEvent): RegistryStamp? = when (event) {
    is HarnessEvent.SessionCreated -> RegistryStamp(event.summary.status, event.summary.updatedAt)
    is HarnessEvent.SessionUpdated -> RegistryStamp(event.status, event.updatedAt)
    else -> null
}

fun registryEventMatchesOpen(event: HarnessEvent, openSessionId: String): Boolean = when (event) {
    is HarnessEvent.SessionCreated ->
        sessionMatchesNative(event.summary.sessionId, openSessionId) ||
            sessionMatchesNative(event.sessionId, openSessionId) ||
            sessionMatchesNative(event.supersedes, openSessionId) ||
            sessionMatchesNative(event.summary.redirectedTo, openSessionId)
    is HarnessEvent.SessionUpdated ->
        sessionMatchesNative(event.previousSessionId, openSessionId) ||
            sessionMatchesNative(event.sessionId, openSessionId)
    else -> false
}

/**
 * Registry `session-updated` / `session-created` for the open session, while
 * a turn is in flight, should fetch the transcript when status becomes
 * idle/ended **or** `updatedAt` moves. The first sight of a stamp
 * (SessionCreated active) is not a change. The fetch itself must not end
 * the turn unless [resyncCompletesTurn] says so — spawn-time idle is not
 * complete.
 */
fun shouldResyncFromRegistry(
    inFlight: Boolean,
    matchesOpenSession: Boolean,
    status: String?,
    updatedAt: String?,
    lastStatus: String?,
    lastUpdatedAt: String?,
): Boolean {
    if (!inFlight || !matchesOpenSession) return false
    if (registryStatusIsQuiet(status) && status != lastStatus) return true
    if (!updatedAt.isNullOrBlank() && lastUpdatedAt != null && updatedAt != lastUpdatedAt) return true
    return false
}

/**
 * Silent poll: every [everyMs] after send, until a content session frame
 * arrives or [boundMs] (the idle deadline). [elapsedSincePollMs] is null
 * before the first poll. Status/accepted frames do not count.
 */
fun transcriptPollDue(
    inFlight: Boolean,
    sawSessionFrame: Boolean,
    elapsedSinceTurnMs: Long,
    elapsedSincePollMs: Long? = null,
    everyMs: Long = TRANSCRIPT_POLL_EVERY_MS,
    boundMs: Long = IDLE_DEADLINE_MS,
): Boolean {
    if (!inFlight || sawSessionFrame) return false
    if (elapsedSinceTurnMs < everyMs) return false
    if (elapsedSinceTurnMs >= boundMs) return false
    if (elapsedSincePollMs != null && elapsedSincePollMs < everyMs) return false
    return true
}

/** Assistant past the prefix captured at [TranscriptMachine.beginTurn]. */
fun fetchedHasNewAssistant(fetched: List<HarnessTranscriptTurn>, committedPrefix: Int): Boolean {
    val from = committedPrefix.coerceAtLeast(0)
    if (fetched.size <= from) return false
    return fetched.drop(from).any { it.role.equals("assistant", ignoreCase = true) }
}

/**
 * A 409 `turn_in_flight` means the den holds the turn (up to 5 min without
 * hooks). Treat it like an accepted send so a later transcript with our
 * assistant can complete; a hard failure must not.
 */
fun injectCompletedAfterSend(ok: Boolean, turnInFlight409: Boolean): Boolean =
    ok || turnInFlight409

/**
 * "Complete" for a poll/registry fetch: the transcript has an assistant
 * turn newer than our pending user turn. A fetch that runs before inject
 * landed, or that only echoes the user turn (or 0 turns), is not complete.
 * A `turn-complete` frame is handled separately via [TranscriptMachine.onFrame].
 */
fun resyncCompletesTurn(
    fetched: List<HarnessTranscriptTurn>,
    pendingUserText: String?,
    committedPrefix: Int,
    injectCompleted: Boolean,
): Boolean {
    if (!injectCompleted) return false
    val from = committedPrefix.coerceAtLeast(0)
    if (!pendingUserText.isNullOrBlank()) {
        val userIdx = fetched.indices.lastOrNull { i ->
            i >= from &&
                fetched[i].role.equals("user", ignoreCase = true) &&
                fetched[i].text == pendingUserText
        } ?: -1
        if (userIdx < 0) return false
        return fetched.drop(userIdx + 1).any { it.role.equals("assistant", ignoreCase = true) }
    }
    return fetchedHasNewAssistant(fetched, from)
}

/**
 * Live-tail content: these cancel/replace the silent poll. Status, accepted,
 * session-updated, and other non-content frames must not.
 */
fun sessionFrameCancelsPoll(event: HarnessEvent): Boolean = when (event) {
    is HarnessEvent.AssistantDelta,
    is HarnessEvent.ReasoningDelta,
    is HarnessEvent.ToolUse,
    is HarnessEvent.TurnComplete,
    is HarnessEvent.Error -> true
    else -> false
}

/**
 * Drop a poll/registry fetch that raced an adopt: the turns belong to the
 * session id we started the fetch with, and only if that attach is still live.
 */
fun resyncStillApplies(
    fetchedForSessionId: String,
    openSessionId: String,
    attachUnchanged: Boolean,
): Boolean = fetchedForSessionId.isNotBlank() &&
    fetchedForSessionId == openSessionId &&
    attachUnchanged

/**
 * redirectedTo echo of the id we already hold: no re-attach, no poll reset.
 * A blank id is also a no-op. Leaving a draft still applies even if the
 * string matches, so we can attach.
 */
fun adoptCanonicalIsNoOp(canonical: String, currentSessionId: String, draft: Boolean): Boolean {
    if (canonical.isBlank()) return true
    return canonical == currentSessionId && !draft
}

/**
 * Silent poll stays armed across an incomplete registry resync. Cancel only
 * when the turn completed, a content session frame arrived, inFlight dropped,
 * or the idle deadline elapsed.
 */
fun silentPollShouldRemainArmed(
    inFlight: Boolean,
    sawSessionFrame: Boolean,
    complete: Boolean,
    elapsedSinceTurnMs: Long,
    boundMs: Long = IDLE_DEADLINE_MS,
): Boolean {
    if (complete || !inFlight || sawSessionFrame) return false
    if (elapsedSinceTurnMs >= boundMs) return false
    return true
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

    /**
     * Drop an in-flight attach fetch so a later poll/registry resync cannot
     * be overwritten by a stale empty open.
     */
    fun bumpGeneration() {
        generation++
        settling = false
        duringSettle.clear()
    }

    /** Peek the transcript route without applying. Errors are swallowed. */
    suspend fun fetchTranscriptNow(): List<HarnessTranscriptTurn>? {
        if (stopped) return null
        return try {
            fetchTranscript()
        } catch (_: Throwable) {
            null
        }
    }

    /** Hard-resync as if `turn-complete` fired (registry idle / silent poll). */
    suspend fun resyncCommitted() {
        if (stopped) return
        settling = true
        duringSettle.clear()
        flushCommittedResync()
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

package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessTranscriptTurn
import io.rivethub.app.gateway.isFatalHarnessEvent
import io.rivethub.app.gateway.isFatalTranscriptError
import io.rivethub.app.gateway.wireJson

const val IDLE_DEADLINE_MS: Long = 3 * 60_000L

/**
 * Grace before the post-turn transcript fetch: the harness store is written
 * as the turn commits, and `turn-complete` can beat the last flush to disk.
 * Twin of `DEFAULT_SETTLE_MS` in rivethub-web `harness-attach.ts`. Kept for
 * HOOKS-sourced (text-only) stores; transcript-sourced sessions skip it.
 */
const val RESYNC_SETTLE_MS: Long = 400L

enum class FrameVerdict { Continue, Fatal }

enum class LiveSource { HOOKS, TRANSCRIPT }

data class AgentStatus(
    val status: String,
    val since: Long = 0,
    val source: String? = null,
    val phase: String? = null,
    val toolName: String? = null,
    val toolCallId: String? = null,
    val promptId: String? = null,
)

/**
 * Stores that expose in-flight turns (tools, thinking, completion) — den's
 * adapter matrix (#709): claude, kimi, grok, hermes. dsh stays hook-sourced.
 */
fun isLiveTurnStore(command: String): Boolean {
    val c = command.lowercase()
    return listOf("claude", "kimi", "grok", "hermes").any { c == it || c.startsWith(it) }
}

/**
 * Port of web `LiveBubble` activity copy: thinking / running &lt;tool&gt; /
 * writing / waiting for you.
 */
fun agentStatusLine(status: String?, phase: String?, toolName: String?): String? {
    if (status == "blocked" || phase == "prompt") return "waiting for you"
    if (status != "working") return null
    return when (phase) {
        "thinking" -> "thinking…"
        "tool" -> "running ${toolName?.takeIf { it.isNotBlank() } ?: "tool"}…"
        "writing" -> "writing…"
        "prompt" -> "waiting for you"
        else -> if (!toolName.isNullOrBlank()) "running $toolName…" else "thinking…"
    }
}

/**
 * Faithful port of `mergeTranscriptWindow` (`packages/types/src/gateway-api.ts`).
 * When a tail-window snapshot overlaps turns we already have, pin the prefix.
 */
fun mergeTranscriptWindow(
    prev: List<HarnessTranscriptTurn>,
    next: List<HarnessTranscriptTurn>,
    truncated: Boolean,
): List<HarnessTranscriptTurn> {
    if (!truncated || prev.isEmpty() || next.isEmpty()) return next.toList()
    val next0 = turnSig(next[0])
    var overlap = -1
    for (i in prev.indices) {
        if (turnSig(prev[i]) == next0) {
            overlap = i
            break
        }
    }
    if (overlap < 0) return next.toList()
    val overlapLen = minOf(prev.size - overlap, next.size)
    for (j in 1 until overlapLen) {
        if (turnSig(prev[overlap + j]) != turnSig(next[j])) return next.toList()
    }
    return prev.subList(0, overlap) + next
}

private fun turnSig(t: HarnessTranscriptTurn): String =
    wireJson.encodeToString(HarnessTranscriptTurn.serializer(), t)

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
    /**
     * Turns confirmed by the node (never our optimistic bubble). While status
     * is working/blocked and the trailing assistant lacks `complete`, that
     * turn is held as live and excluded here.
     */
    val committedTurns: List<HarnessTranscriptTurn>
        get() = if (holdTrailingLive()) committed.dropLast(1) else committed
    private val optimistic = ArrayList<HarnessTranscriptTurn>()

    /** Committed turns plus any unmatched optimistic user bubbles. */
    val transcript: List<HarnessTranscriptTurn>
        get() = if (optimistic.isEmpty()) committedTurns else committedTurns + optimistic
    var liveText: String = ""
        private set
    var liveReasoning: String = ""
        private set
    var liveTools: List<LiveTool> = emptyList()
        private set
    var inFlight: Boolean = false
        private set
    var turnStartTs: Long? = null
        private set
    var lastFrameTs: Long? = null
        private set
    var rev: Int = -1
        private set
    var offset: Int = 0
        private set
    var liveSource: LiveSource = LiveSource.HOOKS
        private set
    var agentStatus: AgentStatus? = null
        private set
    var openPrompt: HarnessEvent.Prompt? = null
        private set
    /** Committed size at [beginTurn] — resync looks for an assistant past this. */
    var committedAtTurnStart: Int = 0
        private set
    /** Optimistic user text captured at [beginTurn]; resync completeness keys off this. */
    var pendingUserText: String? = null
        private set

    private fun holdTrailingLive(): Boolean {
        val st = agentStatus?.status
        if (st != "working" && st != "blocked") return false
        val last = committed.lastOrNull() ?: return false
        return last.role.equals("assistant", ignoreCase = true) && last.complete != true
    }

    private fun deriveFromTrailing() {
        val status = agentStatus?.status
        val busy = status == "working" || status == "blocked"
        if (status != null) inFlight = busy
        if (liveSource != LiveSource.TRANSCRIPT) {
            if (status == "idle") {
                liveText = ""
                liveReasoning = ""
                liveTools = emptyList()
            }
            return
        }
        if (holdTrailingLive()) {
            val t = committed.last()
            liveText = t.text
            liveReasoning = t.thinking.orEmpty()
            liveTools = t.tools.orEmpty().map { LiveTool(it.name, it.input ?: it.args, it.status) }
        } else {
            liveText = ""
            liveReasoning = ""
            liveTools = emptyList()
        }
    }

    /**
     * Apply a pushed transcript frame. Port of web `applyTranscriptFrame`
     * (`stores/chat.ts`) + `mergeTranscriptWindow`. Returns false when the
     * caller must send `{"type":"sync"}`.
     */
    fun applyTranscriptFrame(f: HarnessEvent.Transcript): Boolean {
        lastFrameTs = nowMs()
        if (isLiveTurnStore(f.command)) liveSource = LiveSource.TRANSCRIPT
        val cur = committed
        val turns: List<HarnessTranscriptTurn>
        val nextOffset: Int
        if (f.from == 0) {
            if (f.truncatedBefore && cur.isNotEmpty()) {
                val merged = mergeTranscriptWindow(cur, f.turns, true)
                val pinned = merged.size > f.turns.size
                turns = merged
                nextOffset = if (pinned) merged.size - f.total else 0
            } else {
                turns = f.turns
                nextOffset = 0
            }
        } else if (rev >= 0 && f.rev == rev + 1) {
            val adjustedFrom = f.from + offset
            if (cur.size >= adjustedFrom) {
                turns = cur.take(adjustedFrom) + f.turns
                nextOffset = offset
            } else {
                return false
            }
        } else {
            return false
        }
        if (turns.size - nextOffset != f.total) return false
        committed = turns
        consumeOptimistic(turns)
        rev = f.rev
        offset = nextOffset
        deriveFromTrailing()
        return true
    }

    fun onStatus(s: HarnessEvent.Status) {
        lastFrameTs = nowMs()
        agentStatus = AgentStatus(
            status = s.status,
            since = s.since,
            source = s.source,
            phase = s.phase,
            toolName = s.toolName,
            toolCallId = s.toolCallId,
            promptId = s.promptId,
        )
        deriveFromTrailing()
        if (liveSource == LiveSource.HOOKS) {
            inFlight = s.status == "working" || s.status == "blocked"
        }
    }

    fun onPrompt(p: HarnessEvent.Prompt) {
        lastFrameTs = nowMs()
        openPrompt = if (p.resolved) null else p
    }

    fun beginTurn() {
        val t = nowMs()
        inFlight = true
        turnStartTs = t
        lastFrameTs = t
        if (liveSource == LiveSource.HOOKS) {
            liveText = ""
            liveReasoning = ""
            liveTools = emptyList()
        }
        committedAtTurnStart = committedTurns.size
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
        liveTools = emptyList()
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
        if (liveSource == LiveSource.HOOKS) {
            liveText = ""
            liveReasoning = ""
            liveTools = emptyList()
        } else {
            deriveFromTrailing()
        }
    }

    fun onFrame(event: HarnessEvent): FrameVerdict {
        lastFrameTs = nowMs()
        if (isFatalHarnessEvent(event)) {
            inFlight = false
            return FrameVerdict.Fatal
        }
        val hooks = liveSource == LiveSource.HOOKS
        when (event) {
            is HarnessEvent.AssistantDelta -> if (hooks) {
                liveText += event.text
                if (!inFlight) {
                    inFlight = true
                    if (turnStartTs == null) turnStartTs = lastFrameTs
                }
            }
            is HarnessEvent.ReasoningDelta -> if (hooks) {
                liveReasoning += event.text
                if (!inFlight) {
                    inFlight = true
                    if (turnStartTs == null) turnStartTs = lastFrameTs
                }
            }
            is HarnessEvent.ToolUse -> if (hooks) {
                liveTools = liveTools + LiveTool(event.name, event.input, "running")
                if (!inFlight) {
                    inFlight = true
                    if (turnStartTs == null) turnStartTs = lastFrameTs
                }
            }
            is HarnessEvent.ToolResult -> if (hooks) {
                liveTools = liveTools.map { t ->
                    if (t.name == event.name && t.status == "running") {
                        t.copy(status = if (event.isError) "error" else "done")
                    } else t
                }
                if (!inFlight) {
                    inFlight = true
                    if (turnStartTs == null) turnStartTs = lastFrameTs
                }
            }
            is HarnessEvent.Error -> {
                inFlight = false
            }
            is HarnessEvent.TurnComplete -> {
                if (hooks) inFlight = false
            }
            is HarnessEvent.Status -> onStatus(event)
            is HarnessEvent.Prompt -> onPrompt(event)
            is HarnessEvent.Transcript -> applyTranscriptFrame(event)
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
        liveTools = emptyList()
        inFlight = false
        turnStartTs = null
        lastFrameTs = nowMs()
        pendingUserText = null
    }

    /**
     * Apply a registry fetch. [complete] means an assistant turn is on disk
     * after the pending user; otherwise keep inFlight and only fold committed
     * + optimistic. Used for HOOKS-sourced (text-only) stores.
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
 * Owner of one session attach. Hard-resyncs from [fetchTranscript] on every
 * watch open. Transcript-sourced sessions skip the post-turn-complete settle
 * replay — frames are the source of truth. Fatal error frames and
 * 400/404/410/501 on the transcript route stop the watch so it cannot
 * reconnect into a dead session.
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
        // Transcript-sourced sessions skip HTTP resync-after-turn-complete.
        if (event is HarnessEvent.TurnComplete && machine.liveSource == LiveSource.HOOKS) {
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

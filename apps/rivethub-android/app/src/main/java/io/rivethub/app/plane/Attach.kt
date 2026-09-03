package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessTranscriptTurn

const val IDLE_DEADLINE_MS: Long = 3 * 60_000L

/**
 * Transcript state machine for one harness session.
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

    fun onFrame(event: HarnessEvent) {
        lastFrameTs = nowMs()
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
            else -> Unit
        }
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

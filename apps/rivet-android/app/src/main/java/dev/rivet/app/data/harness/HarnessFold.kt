package dev.rivet.app.data.harness

/**
 * `HarnessEvent` → live turn fold. Kotlin twin of
 * `apps/rivethub-web/src/lib/harness-fold.ts`.
 *
 * Tool pairing is exact: the contract carries a `toolCallId` on both `tool-use`
 * and `tool-result`, so a result marks its own entry instead of the "last
 * running tool with this name" heuristic the den bridge needs.
 *
 * Approvals are deliberately NOT folded — they outlive a turn and the caller
 * holds them separately.
 */

/** One tool call showing in the live turn. */
data class LiveToolEntry(
    val id: String,
    val name: String,
    val status: Status,
) {
    enum class Status { RUNNING, DONE, ERROR }
}

/** The turn in flight, rebuilt from scratch after every gap. */
data class LiveTurn(
    val text: String = "",
    val reasoning: Boolean = false,
    val reasoningText: String = "",
    val tools: List<LiveToolEntry> = emptyList(),
    /** One-line status for a spinner: current tool title or an error note. */
    val activity: String? = null,
) {
    /**
     * True once the turn carries something a user can see. A bare placeholder
     * is not "busy" — it is the window while the harness spins up.
     */
    val isBusy: Boolean
        get() = text.isNotEmpty() || tools.isNotEmpty() || reasoningText.isNotEmpty()
}

object HarnessFold {

    /**
     * Sliding cap on accumulated thinking, matching the den reducer's
     * `THOUGHT_MAX` and the hub's `REASONING_TEXT_MAX`: a long turn's
     * `reasoning-delta` stream would otherwise grow without bound.
     */
    const val REASONING_TEXT_MAX = 4096

    /**
     * Fold one event into the live turn. Returns null on `turn-complete` — the
     * caller clears the live slot and hard-resyncs, which is where the
     * committed turn comes from.
     */
    fun fold(turn: LiveTurn?, event: HarnessEvent): LiveTurn? {
        val base = turn ?: LiveTurn()
        return when (event) {
            is HarnessEvent.AssistantDelta ->
                base.copy(text = base.text + event.text, reasoning = false, activity = null)

            is HarnessEvent.ReasoningDelta -> base.copy(
                reasoning = true,
                reasoningText = nextReasoningText(base.reasoningText, event.text),
            )

            is HarnessEvent.ToolUse -> {
                val entry = LiveToolEntry(event.toolCallId, event.name, LiveToolEntry.Status.RUNNING)
                base.copy(activity = event.name, tools = base.tools + entry)
            }

            is HarnessEvent.ToolResult -> {
                val status =
                    if (event.isError) LiveToolEntry.Status.ERROR else LiveToolEntry.Status.DONE
                val i = base.tools.indexOfFirst { it.id == event.toolCallId }
                val tools = if (i >= 0) {
                    base.tools.toMutableList().also { it[i] = it[i].copy(status = status) }
                } else {
                    // Attached mid-turn: the `tool-use` half predates our
                    // subscription (at-most-once tail — there is no replay).
                    base.tools + LiveToolEntry(event.toolCallId, event.name, status)
                }
                base.copy(activity = null, tools = tools)
            }

            is HarnessEvent.Error ->
                base.copy(activity = event.message.ifBlank { event.code })

            is HarnessEvent.TurnComplete -> null

            is HarnessEvent.SessionUpdated ->
                // A session that ended or errored has no live turn left to show.
                if (event.status == HarnessStatus.ENDED || event.status == HarnessStatus.ERROR) {
                    null
                } else {
                    base
                }

            // session-created / approvals / unknown: not turn state.
            else -> turn
        }
    }

    /** Claude's den hook spinner lines — these REPLACE, never accumulate. */
    private val SPINNER = Regex("^[✳✢✻✽·] ")

    /** Leading partial word to drop once the window is full. */
    private val LEADING_PARTIAL_WORD = Regex("^\\S*\\s+")

    /**
     * Next `reasoningText` for a thinking chunk, by the same rule the hub and
     * the den reducer use. Claude's den hook cannot read real thinking text so
     * it sends spinner status lines, each replacing the last; real streamed
     * thinking (grok's ACP thought chunks) appends and slides through a capped
     * window, trimmed to a word boundary so the stream never opens mid-word.
     */
    fun nextReasoningText(current: String, delta: String): String {
        if (SPINNER.containsMatchIn(delta)) return delta
        val joined = current + delta
        var next = if (joined.length <= REASONING_TEXT_MAX) {
            joined
        } else {
            joined.substring(joined.length - REASONING_TEXT_MAX)
        }
        if (next.length == REASONING_TEXT_MAX) {
            next = LEADING_PARTIAL_WORD.replaceFirst(next, "")
        }
        return next
    }
}

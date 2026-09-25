package io.rivethub.app.plane

/**
 * The harness compaction command the phone can type into the session PTY
 * (UX-SPEC §4 "Compress context"). Only claude-code has one reachable through
 * `POST /api/terminal/inject`; every other harness gets null and the "+" panel
 * hides the item. Ids are normalised through [harnessIdForAgent] so the bare
 * `claude` alias and the canonical `claude-code` agree.
 */
fun compactCommandFor(harnessId: String?): String? {
    val id = harnessId?.trim().orEmpty()
    if (id.isEmpty()) return null
    return if (harnessIdForAgent(id) == "claude-code") CLAUDE_COMPACT else null
}

/** Offered only for a harness with a compact command, and never mid-turn. */
fun canCompact(harnessId: String?, inFlight: Boolean): Boolean =
    !inFlight && compactCommandFor(harnessId) != null

/**
 * What compaction dispatch checks about the conversation: the state the user
 * confirmed on, and the same facts re-read right before the inject.
 * [outboundBusy] is [OutboundPump.busy] — a send queued or sending.
 */
data class CompactCheck(
    val sessionId: String,
    val draft: Boolean,
    val inFlight: Boolean,
    val outboundBusy: Boolean,
)

/**
 * Whether "/compact" may still be typed into the PTY. [before] is the state at
 * confirm; [now] is re-read under the outbound send lock after the PTY setup
 * suspended. Any turn or send that started in between wins and compaction is
 * dropped: a turn in flight, a queued or sending outbound item, a
 * draft, or a different session (adoption or navigation) all refuse.
 */
fun compactMayDispatch(harnessId: String?, before: CompactCheck, now: CompactCheck): Boolean =
    compactCommandFor(harnessId) != null &&
        !before.draft && !now.draft &&
        before.sessionId == now.sessionId &&
        !before.inFlight && !now.inFlight &&
        !before.outboundBusy && !now.outboundBusy

private const val CLAUDE_COMPACT = "/compact"

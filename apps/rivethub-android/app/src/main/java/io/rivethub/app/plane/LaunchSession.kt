package io.rivethub.app.plane

/**
 * Chat-first launch (Phil 2026-09-03/04): opening the app lands IN a session,
 * never the conversations list — the list is only reached via the history
 * icon. Preference order: the most recent session on the CURRENT node (an
 * in-progress draft wins, it holds unsent composer intent), then the most
 * recent session on ANY node (so a hub whose current node has no sessions —
 * e.g. datahub — still resumes the genuinely most recent thread), then, when
 * no session exists anywhere, a NEW draft (the caller mints it from the
 * current agent). Agent-PIN rows are pointers, not sessions, so they are
 * never launch targets. The open-once latch lives in MainActivity and waits
 * for the first FULL load to settle before it fires.
 */
data class LaunchCandidate(
    val key: String,
    /** epoch ms — larger is more recent. */
    val updatedAt: Long,
    /** Only [ChatItemKind.DRAFT] gets the in-progress priority. */
    val kind: ChatItemKind,
    /** The row's home node (trimmed den URL); null = hub-local. */
    val pinNodeBaseUrl: String? = null,
    /** Synthesized agent-pin pointer (not a resumable session) → excluded. */
    val pin: Boolean = false,
)

/**
 * The session to open on launch, or null when there is none to resume (the
 * caller then mints a new draft). Prefers the current node, then any node; a
 * draft beats a finished thread within each scope.
 */
fun pickLaunchSession(items: List<LaunchCandidate>, baseUrl: String): String? {
    val sessions = items.filter { !it.pin }
    fun best(scope: List<LaunchCandidate>): String? {
        val draft = scope.filter { it.kind == ChatItemKind.DRAFT }.maxByOrNull { it.updatedAt }
        if (draft != null) return draft.key
        return scope.maxByOrNull { it.updatedAt }?.key
    }
    val onNode = sessions.filter { it.pinNodeBaseUrl == null || it.pinNodeBaseUrl == baseUrl }
    return best(onNode) ?: best(sessions)
}

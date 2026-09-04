package io.rivethub.app.plane

/**
 * Chat-first launch (Phil 2026-09-03), mirrored from rivethub-web
 * lib/launch-session.ts: opening the app lands in the most recent session for
 * the current node instead of the conversations list. An in-progress draft
 * wins — it holds unsent composer intent, which outranks any finished thread.
 * No candidates at all → null (the list + empty state stays). The open-once
 * latch lives in MainActivity (web: chat.tsx:463-475).
 */
data class LaunchCandidate(
    val key: String,
    /** epoch ms — larger is more recent. */
    val updatedAt: Long,
    /** Only [ChatItemKind.DRAFT] gets the in-progress priority. */
    val kind: ChatItemKind,
    /**
     * The row's home node. Rows from ANOTHER node are not launch candidates
     * ("most recent session for the current node"). Null marks a hub-local
     * row (the web's `pinNodeBaseUrl === undefined` case); the Android
     * adapter sets this for every row because every row knows its node.
     */
    val pinNodeBaseUrl: String? = null,
)

fun pickLaunchSession(items: List<LaunchCandidate>, baseUrl: String): String? {
    val local = items.filter { it.pinNodeBaseUrl == null || it.pinNodeBaseUrl == baseUrl }
    val draft = local.filter { it.kind == ChatItemKind.DRAFT }.maxByOrNull { it.updatedAt }
    if (draft != null) return draft.key
    return local.maxByOrNull { it.updatedAt }?.key
}

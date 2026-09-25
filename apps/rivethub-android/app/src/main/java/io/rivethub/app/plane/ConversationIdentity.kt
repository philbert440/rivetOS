package io.rivethub.app.plane

/**
 * Which identity a conversation row really has, for the long-press menu and
 * for local list prefs (pin / hide) that must follow a session when its key
 * changes.
 *
 * A draft is a conversation the den has not adopted yet: its session id is a
 * bare id without `:` (plane/Inject.kt isDraftSessionId). Two shapes reach the
 * list. A plain draft is a DRAFT row. An agent's unopened draft is synthesized
 * from its agent pointer as a HARNESS row (plane/ChatItems.kt pinChatItems) and
 * the matching DRAFT row is dropped (sortByRecency), so the kind alone does not
 * tell. LEGACY rows are keyed by bare native ids too, but they are real
 * sessions on disk, never drafts.
 */
fun isDraftRow(item: ChatItem, pointerSessionIds: Collection<String>): Boolean = when (item.kind) {
    ChatItemKind.DRAFT -> true
    ChatItemKind.LEGACY -> false
    ChatItemKind.HARNESS ->
        isDraftSessionId(item.key) && (item.pin || item.key in pointerSessionIds)
}

/**
 * One id set after a session key moved [from] → [to]: [from] is dropped and
 * [to] added. The same set comes back when [from] is absent, when the ids are
 * equal, or when either is blank. Exact ids only: two harnesses can share a
 * native half, so a den-room match would move the wrong session's mark.
 */
fun rekeyIdSet(set: Set<String>, from: String, to: String): Set<String> {
    if (from.isBlank() || to.isBlank() || from == to || from !in set) return set
    return set - from + to
}

/**
 * A session key moved from [from] to [to] (draft adopted, or the den rotated
 * the id). Whatever was pinned or hidden under [from] now sits under [to];
 * [from] is gone from both sets. A destination that already carried the mark
 * keeps one entry. Sets untouched by the move come back unchanged.
 */
fun migrateLocalPrefs(
    pinned: Set<String>,
    hidden: Set<String>,
    from: String,
    to: String,
): Pair<Set<String>, Set<String>> = rekeyIdSet(pinned, from, to) to rekeyIdSet(hidden, from, to)

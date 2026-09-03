package io.rivethub.app.plane

/**
 * Filter identity is a sealed type so a node named "All" cannot collide with
 * the unfiltered view. Labels are resolved in the composable from string resources.
 */
sealed interface ConversationFilter {
    data object All : ConversationFilter
    data class Node(val id: String, val name: String) : ConversationFilter
}

fun isActiveStatus(status: String?): Boolean {
    val s = status?.trim()?.lowercase().orEmpty()
    return s == "active" || s == "running" || s == "busy"
}

fun isArchived(item: ChatItem, archived: Set<String>): Boolean {
    if (item.key in archived) return true
    val sid = item.sessionId
    return sid != null && sid != item.key && sid in archived
}

fun displayTitle(item: ChatItem, overrides: Map<String, String>): String {
    overrides[item.key]?.takeIf { it.isNotBlank() }?.let { return it }
    val sid = item.sessionId
    if (sid != null && sid != item.key) {
        overrides[sid]?.takeIf { it.isNotBlank() }?.let { return it }
    }
    return item.title
}

data class ConversationLists(
    val live: List<LocatedChatItem>,
    val archived: List<LocatedChatItem>,
)

/**
 * Split + filter the recency-ordered list. Archived rows always drop out of
 * [ConversationLists.live] and land in [ConversationLists.archived] (still
 * recency-ordered). A node filter matches both sides on node id/name.
 * Query matches display title, key, and harnessId (desktop ConversationsPane).
 */
fun filterConversations(
    items: List<LocatedChatItem>,
    filter: ConversationFilter,
    archived: Set<String>,
    query: String,
    titleOverrides: Map<String, String> = emptyMap(),
): ConversationLists {
    fun passesFilter(it: LocatedChatItem): Boolean = when (filter) {
        ConversationFilter.All -> true
        is ConversationFilter.Node -> it.nodeName == filter.name || it.nodeId == filter.id
    }

    val live = ArrayList<LocatedChatItem>()
    val archivedRows = ArrayList<LocatedChatItem>()
    for (it in items) {
        if (!passesFilter(it)) continue
        val title = displayTitle(it.item, titleOverrides)
        if (!conversationMatchesFilter(title, it.item.key, it.item.harnessId, query)) continue
        if (isArchived(it.item, archived)) archivedRows += it else live += it
    }
    return ConversationLists(live, archivedRows)
}

/** Empty-state copy only when the list is idle — never over a spinner. */
fun conversationsEmptyVisible(loading: Boolean, hasLive: Boolean, hasArchived: Boolean): Boolean =
    !loading && !hasLive && !hasArchived

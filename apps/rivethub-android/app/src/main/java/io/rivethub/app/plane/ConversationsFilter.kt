package io.rivethub.app.plane

const val FILTER_ALL = "All"
const val FILTER_ACTIVE = "Active"
const val FILTER_PINNED = "Pinned"

fun conversationsFilterChips(nodeNames: List<String>): List<String> =
    listOf(FILTER_ALL, FILTER_ACTIVE, FILTER_PINNED) + nodeNames.filter { it.isNotBlank() }

fun isActiveStatus(status: String?): Boolean {
    val s = status?.trim()?.lowercase().orEmpty()
    return s == "active" || s == "running" || s == "busy"
}

fun archiveKey(item: ChatItem): String = item.key

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

fun matchesQuery(title: String, query: String): Boolean {
    val q = query.trim()
    if (q.isEmpty()) return true
    return title.contains(q, ignoreCase = true)
}

data class ConversationLists(
    val live: List<LocatedChatItem>,
    val archived: List<LocatedChatItem>,
)

/**
 * Split + filter the recency-ordered list. Archived rows always drop out of
 * [ConversationLists.live] and land in [ConversationLists.archived] (still
 * recency-ordered). A node chip filters both sides to that node name.
 */
fun filterConversations(
    items: List<LocatedChatItem>,
    filter: String,
    archived: Set<String>,
    pinnedKeys: Set<String>,
    query: String,
    titleOverrides: Map<String, String> = emptyMap(),
): ConversationLists {
    fun pinned(it: LocatedChatItem): Boolean =
        it.item.pin || it.item.key in pinnedKeys || (it.item.sessionId != null && it.item.sessionId in pinnedKeys)

    fun passesFilter(it: LocatedChatItem): Boolean = when (filter) {
        FILTER_ALL -> true
        FILTER_ACTIVE -> isActiveStatus(it.item.status)
        FILTER_PINNED -> pinned(it)
        else -> it.nodeName == filter || it.nodeId == filter
    }

    val live = ArrayList<LocatedChatItem>()
    val archivedRows = ArrayList<LocatedChatItem>()
    for (it in items) {
        if (!passesFilter(it)) continue
        val title = displayTitle(it.item, titleOverrides)
        if (!matchesQuery(title, query)) continue
        if (isArchived(it.item, archived)) archivedRows += it else live += it
    }
    return ConversationLists(live, archivedRows)
}

fun archivedSectionLabel(count: Int): String = "Archived ($count)"

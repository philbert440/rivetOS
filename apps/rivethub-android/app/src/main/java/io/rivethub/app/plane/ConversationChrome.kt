package io.rivethub.app.plane

/** Show the filter box once the list stops being glanceable (desktop pane, phone threshold 8). */
const val CONVERSATION_FILTER_MIN = 8

enum class ConversationEmptyKind { None, NoConversations, NoMatches, AllArchived }

sealed interface NewConversationAction {
    data class ForAgent(val agentId: String) : NewConversationAction
    data object PickAgent : NewConversationAction
}

fun showConversationFilter(itemCount: Int, query: String): Boolean =
    itemCount > CONVERSATION_FILTER_MIN || query.trim().isNotEmpty()

fun conversationEmptyKind(
    total: Int,
    live: Int,
    archived: Int,
    query: String,
): ConversationEmptyKind = when {
    query.trim().isNotEmpty() && live == 0 && archived == 0 -> ConversationEmptyKind.NoMatches
    total == 0 -> ConversationEmptyKind.NoConversations
    live == 0 && archived > 0 && query.trim().isEmpty() -> ConversationEmptyKind.AllArchived
    else -> ConversationEmptyKind.None
}

/**
 * `+ new`: mint a draft for the current agent when that id is still on the
 * roster; otherwise open the agent picker.
 */
fun newConversationAction(currentAgentId: String, agentIds: Collection<String>): NewConversationAction {
    val id = currentAgentId.trim()
    return if (id.isNotEmpty() && id in agentIds) NewConversationAction.ForAgent(id)
    else NewConversationAction.PickAgent
}

fun conversationMatchesFilter(
    title: String,
    key: String,
    harnessId: String?,
    query: String,
): Boolean {
    val q = query.trim()
    if (q.isEmpty()) return true
    if (title.contains(q, ignoreCase = true)) return true
    if (key.contains(q, ignoreCase = true)) return true
    return (harnessId ?: "").contains(q, ignoreCase = true)
}

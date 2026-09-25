package io.rivethub.app.plane

/** Long-press actions on a conversation row (UX-SPEC §2 item 2). */
enum class ConversationAction { Pin, Unpin, Rename, MoveToAgent, Archive, Unarchive, Hide, DiscardDraft }

/**
 * Menu contents, top to bottom. A draft only offers Discard draft (it has no
 * session on the den yet). Everything else: Pin or Unpin, Rename, Move to
 * agent when there is more than one agent to move between, Archive or
 * Unarchive, Hide.
 */
fun conversationActions(
    pinned: Boolean,
    archived: Boolean,
    draft: Boolean,
    agentCount: Int,
): List<ConversationAction> {
    if (draft) return listOf(ConversationAction.DiscardDraft)
    val out = ArrayList<ConversationAction>(5)
    out += if (pinned) ConversationAction.Unpin else ConversationAction.Pin
    out += ConversationAction.Rename
    if (agentCount > 1) out += ConversationAction.MoveToAgent
    out += if (archived) ConversationAction.Unarchive else ConversationAction.Archive
    out += ConversationAction.Hide
    return out
}

/**
 * Move to agent: [agentId]'s pointer now names [sessionKey] on [nodeBaseUrl],
 * and any OTHER agent whose pointer named [sessionKey] loses its pointer (a
 * session belongs to one agent). Agents pointing elsewhere are untouched.
 * The moved pointer carries [nowMs]. Returns the whole new map.
 */
fun moveSessionToAgent(
    all: Map<String, AgentPointer>,
    sessionKey: String,
    agentId: String,
    nodeBaseUrl: String,
    nowMs: Long,
): Map<String, AgentPointer> {
    val out = LinkedHashMap<String, AgentPointer>()
    for ((id, ptr) in all) {
        if (id == agentId) continue
        if (ptr.sessionId == sessionKey) continue
        out[id] = ptr
    }
    out[agentId] = AgentPointer(sessionKey, nodeBaseUrl, nowMs)
    return out
}

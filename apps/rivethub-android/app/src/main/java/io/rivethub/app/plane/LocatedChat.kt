package io.rivethub.app.plane

/** A [ChatItem] tagged with the node it was listed on. Open-chat transport stays on [nodeDenUrl]. */
data class LocatedChatItem(
    val item: ChatItem,
    val nodeId: String,
    val nodeName: String,
    val nodeDenUrl: String,
)

fun locate(item: ChatItem, nodeId: String, nodeName: String, nodeDenUrl: String): LocatedChatItem =
    LocatedChatItem(item, nodeId, nodeName, nodeDenUrl)

/** Newest-first across every node. Pins stay mingled (desktop 0.5.14). */
fun sortLocatedByRecency(items: List<LocatedChatItem>): List<LocatedChatItem> =
    items.sortedWith(compareByDescending<LocatedChatItem> { it.item.updatedAt }.thenBy { it.item.key })

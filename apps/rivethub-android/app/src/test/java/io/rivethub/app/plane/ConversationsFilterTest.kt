package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationsFilterTest {
    private val uuid = "a1b2c3d4-1111-4222-8333-444455556666"

    private fun item(
        key: String,
        title: String = key,
        status: String? = "idle",
        pin: Boolean = false,
        updatedAt: Long = 1,
        sessionId: String? = key,
        kind: ChatItemKind = ChatItemKind.HARNESS,
    ) = ChatItem(
        key = key,
        kind = kind,
        title = title,
        sessionId = sessionId,
        harnessId = "claude-code",
        status = status,
        updatedAt = updatedAt,
        pin = pin,
    )

    private fun loc(
        key: String,
        nodeName: String = "ct115",
        nodeId: String = "ct115",
        title: String = key,
        status: String? = "idle",
        pin: Boolean = false,
        updatedAt: Long = 1,
        kind: ChatItemKind = ChatItemKind.HARNESS,
    ) = LocatedChatItem(
        item(key, title, status, pin, updatedAt, kind = kind),
        nodeId = nodeId,
        nodeName = nodeName,
        nodeDenUrl = "https://192.0.2.10:5174",
    )

    @Test fun `All hides archived and keeps recency order`() {
        val items = listOf(loc("a", updatedAt = 3), loc("b", updatedAt = 2), loc("c", updatedAt = 1))
        val lists = filterConversations(items, ConversationFilter.All, archived = setOf("b"), query = "")
        assertEquals(listOf("a", "c"), lists.live.map { it.item.key })
        assertEquals(listOf("b"), lists.archived.map { it.item.key })
    }

    @Test fun `node chip filters by node name`() {
        val items = listOf(loc("a", nodeName = "ct115"), loc("b", nodeName = "ct119"))
        val lists = filterConversations(items, ConversationFilter.Node("ct119", "ct119"), emptySet(), "")
        assertEquals(listOf("b"), lists.live.map { it.item.key })
    }

    @Test fun `query matches title override not the raw title`() {
        val items = listOf(loc("a", title = "raw"))
        val miss = filterConversations(items, ConversationFilter.All, emptySet(), "secret", mapOf("a" to "secret name"))
        assertEquals(1, miss.live.size)
        val none = filterConversations(items, ConversationFilter.All, emptySet(), "raw", mapOf("a" to "secret name"))
        assertEquals(0, none.live.size)
    }

    @Test fun `query matches key and harness through the shipped filter`() {
        val items = listOf(loc("sess-abc", title = "Notes"))
        assertEquals(1, filterConversations(items, ConversationFilter.All, emptySet(), "sess-abc").live.size)
        assertEquals(1, filterConversations(items, ConversationFilter.All, emptySet(), "claude").live.size)
        assertEquals(0, filterConversations(items, ConversationFilter.All, emptySet(), "xyz").live.size)
    }

    @Test fun `displayTitle prefers override`() {
        val it = item(uuid, title = "native")
        assertEquals("renamed", displayTitle(it, mapOf(uuid to "renamed")))
        assertEquals("native", displayTitle(it, emptyMap()))
    }

    @Test fun `a node named All is not the All filter`() {
        val items = listOf(loc("a", nodeName = "All", nodeId = "n-all"), loc("b", nodeName = "ct115", nodeId = "ct115"))
        val all = filterConversations(items, ConversationFilter.All, emptySet(), "")
        assertEquals(listOf("a", "b"), all.live.map { it.item.key })
        val node = filterConversations(items, ConversationFilter.Node("n-all", "All"), emptySet(), "")
        assertEquals(listOf("a"), node.live.map { it.item.key })
    }

    @Test fun `sortLocatedByRecency is newest first and stable on ties`() {
        val a = loc("a", updatedAt = 5)
        val b = loc("b", updatedAt = 5)
        val c = loc("c", updatedAt = 9)
        val sorted = sortLocatedByRecency(listOf(b, a, c))
        assertEquals("c", sorted[0].item.key)
        assertEquals(listOf("a", "b"), sorted.drop(1).map { it.item.key })
    }

    @Test fun `empty conversations hidden while loading`() {
        assertFalse(conversationsEmptyVisible(loading = true, hasLive = false, hasArchived = false))
        assertTrue(conversationsEmptyVisible(loading = false, hasLive = false, hasArchived = false))
        assertFalse(conversationsEmptyVisible(loading = false, hasLive = true, hasArchived = false))
        assertFalse(conversationsEmptyVisible(loading = false, hasLive = false, hasArchived = true))
    }
}

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

    @Test fun `chips are All Active Pinned then node names`() {
        assertEquals(
            listOf("All", "Active", "Pinned", "ct115", "ct119"),
            conversationsFilterChips(listOf("ct115", "ct119")),
        )
    }

    @Test fun `blank node names are dropped from chips`() {
        assertEquals(listOf("All", "Active", "Pinned"), conversationsFilterChips(listOf("", "  ")))
    }

    @Test fun `All hides archived and keeps recency order`() {
        val items = listOf(loc("a", updatedAt = 3), loc("b", updatedAt = 2), loc("c", updatedAt = 1))
        val lists = filterConversations(items, FILTER_ALL, archived = setOf("b"), pinnedKeys = emptySet(), query = "")
        assertEquals(listOf("a", "c"), lists.live.map { it.item.key })
        assertEquals(listOf("b"), lists.archived.map { it.item.key })
    }

    @Test fun `Active keeps only active or running`() {
        val items = listOf(
            loc("a", status = "active"),
            loc("b", status = "idle"),
            loc("c", status = "running"),
            loc("d", status = "BUSY"),
        )
        val lists = filterConversations(items, FILTER_ACTIVE, emptySet(), emptySet(), "")
        assertEquals(listOf("a", "c", "d"), lists.live.map { it.item.key })
    }

    @Test fun `Pinned keeps pin flag and pointer keys`() {
        val items = listOf(loc("a", pin = true), loc("b"), loc("c"))
        val lists = filterConversations(items, FILTER_PINNED, emptySet(), pinnedKeys = setOf("c"), query = "")
        assertEquals(listOf("a", "c"), lists.live.map { it.item.key })
    }

    @Test fun `node chip filters by node name`() {
        val items = listOf(loc("a", nodeName = "ct115"), loc("b", nodeName = "ct119"))
        val lists = filterConversations(items, "ct119", emptySet(), emptySet(), "")
        assertEquals(listOf("b"), lists.live.map { it.item.key })
    }

    @Test fun `query matches title override not the raw title`() {
        val items = listOf(loc("a", title = "raw"))
        val miss = filterConversations(items, FILTER_ALL, emptySet(), emptySet(), "secret", mapOf("a" to "secret name"))
        assertEquals(1, miss.live.size)
        val none = filterConversations(items, FILTER_ALL, emptySet(), emptySet(), "raw", mapOf("a" to "secret name"))
        assertEquals(0, none.live.size)
    }

    @Test fun `displayTitle prefers override`() {
        val it = item(uuid, title = "native")
        assertEquals("renamed", displayTitle(it, mapOf(uuid to "renamed")))
        assertEquals("native", displayTitle(it, emptyMap()))
    }

    @Test fun `archive key is the row key`() {
        assertEquals("k", archiveKey(item("k")))
        assertTrue(isArchived(item("k"), setOf("k")))
        assertFalse(isArchived(item("k"), setOf("other")))
    }

    @Test fun `archived section label carries the count`() {
        assertEquals("Archived (3)", archivedSectionLabel(3))
        assertEquals("Archived (0)", archivedSectionLabel(0))
    }

    @Test fun `sortLocatedByRecency is newest first and stable on ties`() {
        val a = loc("a", updatedAt = 5)
        val b = loc("b", updatedAt = 5)
        val c = loc("c", updatedAt = 9)
        val sorted = sortLocatedByRecency(listOf(b, a, c))
        assertEquals("c", sorted[0].item.key)
        assertEquals(listOf("a", "b"), sorted.drop(1).map { it.item.key })
    }

    @Test fun `empty query matches everything`() {
        assertTrue(matchesQuery("hello", ""))
        assertTrue(matchesQuery("hello", "  "))
        assertFalse(matchesQuery("hello", "xyz"))
        assertTrue(matchesQuery("Hello World", "world"))
    }
}

package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationChromeTest {
    private fun loc(key: String, title: String = key, kind: ChatItemKind = ChatItemKind.HARNESS) = LocatedChatItem(
        ChatItem(key = key, kind = kind, title = title, sessionId = key, harnessId = "claude-code"),
        nodeId = "n",
        nodeName = "n",
        nodeDenUrl = "https://192.0.2.10:5174",
    )

    @Test
    fun `live count excludes archived`() {
        val items = listOf(loc("a"), loc("b"), loc("c"))
        assertEquals(3, liveConversationCount(items, emptySet()))
        assertEquals(2, liveConversationCount(items, setOf("b")))
        assertEquals(0, liveConversationCount(items, setOf("a", "b", "c")))
    }

    @Test
    fun `archived split keeps recency of each side`() {
        val items = listOf(loc("a"), loc("b"), loc("c"))
        val lists = filterConversations(items, ConversationFilter.All, setOf("b"), emptySet(), "")
        assertEquals(listOf("a", "c"), lists.live.map { it.item.key })
        assertEquals(listOf("b"), lists.archived.map { it.item.key })
    }

    @Test
    fun `filter matching hits title key and harness`() {
        assertTrue(conversationMatchesFilter("Notes", "abc", "claude-code", "note"))
        assertTrue(conversationMatchesFilter("Notes", "abc", "claude-code", "abc"))
        assertTrue(conversationMatchesFilter("Notes", "abc", "claude-code", "claude"))
        assertFalse(conversationMatchesFilter("Notes", "abc", "claude-code", "xyz"))
        assertTrue(conversationMatchesFilter("Notes", "abc", "claude-code", ""))
    }

    @Test
    fun `filter box appears after eight items or when query is set`() {
        assertFalse(showConversationFilter(8, ""))
        assertTrue(showConversationFilter(9, ""))
        assertTrue(showConversationFilter(1, "x"))
    }

    @Test
    fun `empty kinds cover none matches archived`() {
        assertEquals(ConversationEmptyKind.NoConversations, conversationEmptyKind(0, 0, 0, ""))
        assertEquals(ConversationEmptyKind.NoMatches, conversationEmptyKind(4, 0, 0, "zzz"))
        assertEquals(ConversationEmptyKind.AllArchived, conversationEmptyKind(2, 0, 2, ""))
        assertEquals(ConversationEmptyKind.None, conversationEmptyKind(2, 1, 1, ""))
    }

    @Test
    fun `plus new uses the current agent when it is on the roster`() {
        val action = newConversationAction("agent-1", listOf("agent-1", "agent-2"))
        assertEquals(NewConversationAction.ForAgent("agent-1"), action)
    }

    @Test
    fun `plus new opens the picker when no current agent is selected`() {
        assertEquals(NewConversationAction.PickAgent, newConversationAction("", listOf("agent-1")))
        assertEquals(NewConversationAction.PickAgent, newConversationAction("gone", listOf("agent-1")))
        assertEquals(NewConversationAction.PickAgent, newConversationAction("agent-1", emptyList()))
    }
}

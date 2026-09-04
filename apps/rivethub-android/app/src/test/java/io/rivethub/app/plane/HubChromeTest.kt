package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HubChromeTest {
    @Test
    fun `top bar shows the wordmark on the conversations home`() {
        assertEquals(TopBarTitle.Wordmark, topBarTitle(HubTab.Conversations))
    }

    @Test
    fun `top bar shows the page title on settings and the wordmark on a session`() {
        assertEquals(TopBarTitle.Settings, topBarTitle(HubTab.Settings))
        // session / enroll screens have no hub tab — the bar keeps the wordmark
        assertEquals(TopBarTitle.Wordmark, topBarTitle(null))
    }

    @Test
    fun `conversation pane rows are a flat one-to-one mapping with no group headers`() {
        val items = listOf(
            LocatedChatItem(ChatItem(key = "a:1", kind = ChatItemKind.HARNESS, title = "one"), "n1", "node-a", "https://a"),
            LocatedChatItem(ChatItem(key = "b:2", kind = ChatItemKind.DRAFT, title = "new conversation"), "n1", "node-a", "https://a"),
            LocatedChatItem(ChatItem(key = "c:3", kind = ChatItemKind.LEGACY, title = "three"), "n2", "node-b", "https://b"),
        )
        val rows = paneRows(items)
        // chat.tsx:833 renders the recency list 1:1 — no node/agent group rows
        assertEquals(items.size, rows.size)
        assertEquals(items.map { it.item.key }, rows.map { it.item.key })
        assertEquals(items.map { it.item.title }, rows.map { it.item.title })
    }

    @Test
    fun `discovering line shows only while bundles are pending`() {
        assertTrue(discoveringLineVisible(done = 1, total = 3))
        assertFalse(discoveringLineVisible(done = 0, total = 0))
        assertFalse(discoveringLineVisible(done = 3, total = 3))
        assertFalse(discoveringLineVisible(done = 4, total = 3))
    }

    @Test
    fun `drawer width follows the sidebar w-64 rule with the narrow-screen fallback`() {
        assertEquals(256f, drawerWidthDp(412f), 0.001f)
        assertEquals(256f, drawerWidthDp(360f), 0.001f)
        assertEquals(256f, drawerWidthDp(320f), 0.001f)
        assertEquals(238f, drawerWidthDp(280f), 0.001f)
    }
}

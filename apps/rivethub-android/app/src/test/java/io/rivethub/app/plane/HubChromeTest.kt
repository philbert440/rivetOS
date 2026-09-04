package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HubChromeTest {
    @Test
    fun `top bar shows the wordmark on the conversations home`() {
        assertEquals(TopBarTitle.Wordmark, topBarTitle(HubTab.Conversations))
    }

    @Test
    fun `top bar shows the page title on settings`() {
        assertEquals(TopBarTitle.Settings, topBarTitle(HubTab.Settings))
    }

    @Test
    fun `the wordmark bar is a hub-tab bar only — a session owns its own one-row header`() {
        // lib/session-header.ts showMobileTopBar: the bar shows on every
        // narrow screen EXCEPT an open session, so topBarTitle takes a real
        // hub tab — there is no session (null) input anymore. Pin both
        // mappings so the rule cannot silently flip.
        assertEquals(TopBarTitle.Wordmark, topBarTitle(HubTab.Conversations))
        assertEquals(TopBarTitle.Settings, topBarTitle(HubTab.Settings))
        assertNotEquals(topBarTitle(HubTab.Conversations), topBarTitle(HubTab.Settings))
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

package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DrawerNavTest {
    @Test
    fun `conversations is active on the conversations tab`() {
        assertTrue(drawerItemActive(DrawerDest.Conversations, HubTab.Conversations))
        assertFalse(drawerItemActive(DrawerDest.Conversations, HubTab.Settings))
    }

    @Test
    fun `settings is active on the settings tab`() {
        assertTrue(drawerItemActive(DrawerDest.Settings, HubTab.Settings))
        assertFalse(drawerItemActive(DrawerDest.Settings, HubTab.Conversations))
    }

    @Test
    fun `phase-two rows never resolve as active`() {
        for (dest in listOf(DrawerDest.Memory, DrawerDest.Files, DrawerDest.Tasks, DrawerDest.Workflows)) {
            assertFalse(drawerDestEnabled(dest))
            assertFalse(drawerItemActive(dest, HubTab.Conversations))
            assertFalse(drawerItemActive(dest, HubTab.Settings))
            assertNull(hubTabOf(dest))
        }
    }

    @Test
    fun `primary nav is conversations then memory then files`() {
        assertEquals(
            listOf(DrawerDest.Conversations, DrawerDest.Memory, DrawerDest.Files),
            drawerPrimaryNav(),
        )
    }

    @Test
    fun `secondary nav is tasks then workflows`() {
        assertEquals(listOf(DrawerDest.Tasks, DrawerDest.Workflows), drawerSecondaryNav())
    }

    @Test
    fun `unread badge is blank at zero`() {
        assertNull(formatUnreadBadge(0))
        assertNull(formatUnreadBadge(-3))
    }

    @Test
    fun `unread badge formats 99 plus`() {
        assertEquals("1", formatUnreadBadge(1))
        assertEquals("99", formatUnreadBadge(99))
        assertEquals("99+", formatUnreadBadge(100))
        assertEquals("99+", formatUnreadBadge(250))
    }

    @Test
    fun `back from settings returns to conversations`() {
        assertEquals(HubTab.Conversations, hubTabOnBack(HubTab.Settings))
        assertNull(hubTabOnBack(HubTab.Conversations))
    }

    @Test
    fun `drawer nav from a session resolves the same hub tab as from the hub`() {
        // Session-header slice: the session screen lives inside the same left
        // drawer, and MainActivity routes BOTH origins through drawerTabRoute —
        // the session pop back to the hub is the UI's only extra step.
        for (dest in DrawerDest.entries) {
            assertEquals(hubTabOf(dest), drawerTabRoute(dest))
        }
    }

    @Test
    fun `session drawer nav maps enabled rows to their tabs and leaves phase-two rows inert`() {
        assertEquals(HubTab.Conversations, drawerTabRoute(DrawerDest.Conversations))
        assertEquals(HubTab.Settings, drawerTabRoute(DrawerDest.Settings))
        for (dest in listOf(DrawerDest.Memory, DrawerDest.Files, DrawerDest.Tasks, DrawerDest.Workflows)) {
            assertNull(drawerTabRoute(dest))
        }
    }
}

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
        for (dest in listOf(DrawerDest.Files, DrawerDest.Tasks, DrawerDest.Workflows)) {
            assertFalse(drawerDestEnabled(dest))
            assertFalse(drawerItemActive(dest, HubTab.Conversations))
            assertFalse(drawerItemActive(dest, HubTab.Settings))
            assertNull(hubTabOf(dest))
        }
    }

    @Test
    fun `memory is enabled and routes to its own screen, never a hub tab`() {
        assertTrue(drawerDestEnabled(DrawerDest.Memory))
        assertTrue(drawerDestEnabled(DrawerDest.Memory, ExperimentalFlags()))
        assertTrue(drawerOpensMemoryScreen(DrawerDest.Memory))
        assertFalse(drawerOpensMemoryScreen(DrawerDest.Conversations))
        // Not a hub tab: no tab mapping and no active highlight on either tab.
        assertNull(hubTabOf(DrawerDest.Memory))
        assertNull(drawerTabRoute(DrawerDest.Memory))
        assertFalse(drawerItemActive(DrawerDest.Memory, HubTab.Conversations))
        assertFalse(drawerItemActive(DrawerDest.Memory, HubTab.Settings))
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
    fun `session drawer nav maps tab rows to their tabs, memory and phase-two rows have no tab`() {
        assertEquals(HubTab.Conversations, drawerTabRoute(DrawerDest.Conversations))
        assertEquals(HubTab.Settings, drawerTabRoute(DrawerDest.Settings))
        // Memory navigates (drawerOpensMemoryScreen) but never through a hub tab.
        for (dest in listOf(DrawerDest.Memory, DrawerDest.Files, DrawerDest.Tasks, DrawerDest.Workflows)) {
            assertNull(drawerTabRoute(dest))
        }
    }
}

class DrawerExperimentalTest {
    @Test
    fun `drawerDestVisible matrix — each flag on or off shows the matching dest`() {
        data class Case(val files: Boolean, val tasks: Boolean, val workflows: Boolean)
        val cases = listOf(
            Case(false, false, false),
            Case(true, false, false),
            Case(false, true, false),
            Case(false, false, true),
            Case(true, true, false),
            Case(true, false, true),
            Case(false, true, true),
            Case(true, true, true),
        )
        for (c in cases) {
            val exp = ExperimentalFlags(c.files, c.tasks, c.workflows)
            for (dest in DrawerDest.entries) {
                val expected = when (dest) {
                    DrawerDest.Conversations, DrawerDest.Memory, DrawerDest.Settings -> true
                    DrawerDest.Files -> c.files
                    DrawerDest.Tasks -> c.tasks
                    DrawerDest.Workflows -> c.workflows
                }
                assertEquals("$dest files=${c.files} tasks=${c.tasks} workflows=${c.workflows}", expected, drawerDestVisible(dest, exp))
            }
        }
    }

    @Test
    fun `drawerDestEnabled enables experimental dests only when their flag is on, memory is always on`() {
        val off = ExperimentalFlags()
        val on = ExperimentalFlags(files = true, tasks = true, workflows = true)
        assertTrue(drawerDestEnabled(DrawerDest.Conversations, off))
        assertTrue(drawerDestEnabled(DrawerDest.Settings, off))
        // Memory is not experimental — flags never gate it.
        assertTrue(drawerDestEnabled(DrawerDest.Memory, off))
        assertTrue(drawerDestEnabled(DrawerDest.Memory, on))
        assertFalse(drawerDestEnabled(DrawerDest.Files, off))
        assertFalse(drawerDestEnabled(DrawerDest.Tasks, off))
        assertFalse(drawerDestEnabled(DrawerDest.Workflows, off))
        assertTrue(drawerDestEnabled(DrawerDest.Files, on))
        assertTrue(drawerDestEnabled(DrawerDest.Tasks, on))
        assertTrue(drawerDestEnabled(DrawerDest.Workflows, on))
        // No-arg overload stays the default-off contract.
        assertFalse(drawerDestEnabled(DrawerDest.Files))
        assertTrue(drawerDestEnabled(DrawerDest.Memory))
    }

    @Test
    fun `visible primary and secondary lists drop gated dests when off`() {
        val off = ExperimentalFlags()
        assertEquals(
            listOf(DrawerDest.Conversations, DrawerDest.Memory),
            drawerVisiblePrimary(off),
        )
        assertEquals(emptyList<DrawerDest>(), drawerVisibleSecondary(off))
        assertEquals(
            listOf(DrawerDest.Conversations, DrawerDest.Memory, DrawerDest.Files),
            drawerVisiblePrimary(ExperimentalFlags(files = true)),
        )
        assertEquals(listOf(DrawerDest.Tasks), drawerVisibleSecondary(ExperimentalFlags(tasks = true)))
        assertEquals(
            listOf(DrawerDest.Workflows),
            drawerVisibleSecondary(ExperimentalFlags(workflows = true)),
        )
        val all = ExperimentalFlags(files = true, tasks = true, workflows = true)
        assertEquals(drawerPrimaryNav(), drawerVisiblePrimary(all))
        assertEquals(drawerSecondaryNav(), drawerVisibleSecondary(all))
    }

    @Test
    fun `stored experimental flags treat null as off`() {
        assertEquals(ExperimentalFlags(), storedExperimentalFlags(null, null, null))
        assertEquals(
            ExperimentalFlags(files = true, tasks = false, workflows = false),
            storedExperimentalFlags(true, null, false),
        )
        assertEquals(
            ExperimentalFlags(files = false, tasks = true, workflows = true),
            storedExperimentalFlags(null, true, true),
        )
    }
}

class ChatHomeNavTest {
    @Test
    fun `left-nav conversations on a session is already home`() {
        assertEquals(ChatHomeNav.AlreadyHome, chatHomeNav(currentIsChat = true, stackHasChat = true))
    }

    @Test
    fun `left-nav conversations from settings pops back to the open session`() {
        assertEquals(ChatHomeNav.PopToSession, chatHomeNav(currentIsChat = false, stackHasChat = true))
    }

    @Test
    fun `left-nav conversations with no session on the stack resolves a launch pick`() {
        assertEquals(ChatHomeNav.Resolve, chatHomeNav(currentIsChat = false, stackHasChat = false))
    }
}

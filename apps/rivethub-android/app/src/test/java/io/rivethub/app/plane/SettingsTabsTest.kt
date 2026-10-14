package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsTabsTest {
    @Test
    fun `tabs keep the desktop rail order without Keyboard`() {
        assertEquals(
            listOf("general", "appearance", "node", "device", "advanced"),
            SettingsTab.entries.map { it.id },
        )
    }

    @Test
    fun `unknown or missing id opens General`() {
        assertEquals(SettingsTab.General, settingsTab(null))
        assertEquals(SettingsTab.General, settingsTab("keyboard"))
        assertEquals(SettingsTab.Advanced, settingsTab("advanced"))
    }
}

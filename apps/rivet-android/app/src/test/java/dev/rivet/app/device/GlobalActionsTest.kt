package dev.rivet.app.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for pure global-action mapping (expanded performGlobalAction surface).
 */
class GlobalActionsTest {

    @Test
    fun `globalActionCode maps known names case-insensitively`() {
        assertEquals(GLOBAL_ACTION_BACK, globalActionCode("BACK"))
        assertEquals(GLOBAL_ACTION_BACK, globalActionCode("back"))
        assertEquals(GLOBAL_ACTION_HOME, globalActionCode("Home"))
        assertEquals(GLOBAL_ACTION_RECENTS, globalActionCode("RECENTS"))
        assertEquals(GLOBAL_ACTION_NOTIFICATIONS, globalActionCode("notifications"))
        assertEquals(GLOBAL_ACTION_QUICK_SETTINGS, globalActionCode("QUICK_SETTINGS"))
        assertEquals(GLOBAL_ACTION_POWER_DIALOG, globalActionCode("POWER_DIALOG"))
        assertEquals(GLOBAL_ACTION_LOCK_SCREEN, globalActionCode("lock_screen"))
        assertEquals(GLOBAL_ACTION_TAKE_SCREENSHOT, globalActionCode("TAKE_SCREENSHOT"))
        assertEquals(
            GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE,
            globalActionCode("DISMISS_NOTIFICATION_SHADE"),
        )
    }

    @Test
    fun `globalActionCode trims whitespace`() {
        assertEquals(GLOBAL_ACTION_HOME, globalActionCode("  HOME  "))
    }

    @Test
    fun `globalActionCode unknown is null`() {
        assertNull(globalActionCode(""))
        assertNull(globalActionCode("   "))
        assertNull(globalActionCode("SPLIT_SCREEN"))
        assertNull(globalActionCode("screenshot")) // lowercase alias not accepted; use TAKE_SCREENSHOT
        assertNull(globalActionCode("TOGGLE_SPLIT_SCREEN"))
        assertNull(globalActionCode("ACCESSIBILITY_ALL_APPS"))
    }

    @Test
    fun `GLOBAL_ACTION_NAMES lists all mappable actions`() {
        for (name in GLOBAL_ACTION_NAMES) {
            assertNotNull("missing mapping for $name", globalActionCode(name))
        }
        assertEquals(9, GLOBAL_ACTION_NAMES.size)
    }

    @Test
    fun `constant values match AccessibilityService GLOBAL_ACTION ids`() {
        // Stable framework integers (compileSdk 37 / AOSP).
        assertEquals(1, GLOBAL_ACTION_BACK)
        assertEquals(2, GLOBAL_ACTION_HOME)
        assertEquals(3, GLOBAL_ACTION_RECENTS)
        assertEquals(4, GLOBAL_ACTION_NOTIFICATIONS)
        assertEquals(5, GLOBAL_ACTION_QUICK_SETTINGS)
        assertEquals(6, GLOBAL_ACTION_POWER_DIALOG)
        assertEquals(8, GLOBAL_ACTION_LOCK_SCREEN)
        assertEquals(9, GLOBAL_ACTION_TAKE_SCREENSHOT)
        assertEquals(15, GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
    }

    @Test
    fun `globalActionMinSdk gates API 28, 30, 31 actions only`() {
        assertNull(globalActionMinSdk(GLOBAL_ACTION_BACK))
        assertNull(globalActionMinSdk(GLOBAL_ACTION_HOME))
        assertNull(globalActionMinSdk(GLOBAL_ACTION_POWER_DIALOG))
        assertEquals(28, globalActionMinSdk(GLOBAL_ACTION_LOCK_SCREEN))
        assertEquals(30, globalActionMinSdk(GLOBAL_ACTION_TAKE_SCREENSHOT))
        assertEquals(31, globalActionMinSdk(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE))
    }

    @Test
    fun `isGlobalActionSupported respects sdkInt`() {
        assertTrue(isGlobalActionSupported(GLOBAL_ACTION_BACK, 26))
        assertTrue(isGlobalActionSupported(GLOBAL_ACTION_POWER_DIALOG, 26))
        assertFalse(isGlobalActionSupported(GLOBAL_ACTION_LOCK_SCREEN, 27))
        assertTrue(isGlobalActionSupported(GLOBAL_ACTION_LOCK_SCREEN, 28))
        assertFalse(isGlobalActionSupported(GLOBAL_ACTION_TAKE_SCREENSHOT, 29))
        assertTrue(isGlobalActionSupported(GLOBAL_ACTION_TAKE_SCREENSHOT, 30))
        assertFalse(isGlobalActionSupported(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE, 30))
        assertTrue(isGlobalActionSupported(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE, 31))
    }

    @Test
    fun `resolveGlobalAction null when unknown or below minSdk`() {
        assertNull(resolveGlobalAction("NOPE", 37))
        assertNull(resolveGlobalAction("LOCK_SCREEN", 27))
        assertEquals(GLOBAL_ACTION_LOCK_SCREEN, resolveGlobalAction("LOCK_SCREEN", 28))
        assertNull(resolveGlobalAction("DISMISS_NOTIFICATION_SHADE", 30))
        assertEquals(
            GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE,
            resolveGlobalAction("DISMISS_NOTIFICATION_SHADE", 31),
        )
        assertEquals(GLOBAL_ACTION_HOME, resolveGlobalAction("HOME", 26))
    }

    @Test
    fun `globalsCapabilityArray filters by sdk`() {
        val at26 = globalsCapabilityArray(26)
        val names26 = (0 until at26.length()).map { at26.getString(it) }.toSet()
        assertTrue(names26.contains("BACK"))
        assertTrue(names26.contains("POWER_DIALOG"))
        assertFalse(names26.contains("LOCK_SCREEN"))
        assertFalse(names26.contains("TAKE_SCREENSHOT"))
        assertFalse(names26.contains("DISMISS_NOTIFICATION_SHADE"))
        assertEquals(6, at26.length())

        val at28 = globalsCapabilityArray(28)
        val names28 = (0 until at28.length()).map { at28.getString(it) }.toSet()
        assertTrue(names28.contains("LOCK_SCREEN"))
        assertFalse(names28.contains("TAKE_SCREENSHOT"))
        assertFalse(names28.contains("DISMISS_NOTIFICATION_SHADE"))
        assertEquals(7, at28.length())

        val at30 = globalsCapabilityArray(30)
        val names30 = (0 until at30.length()).map { at30.getString(it) }.toSet()
        assertTrue(names30.contains("TAKE_SCREENSHOT"))
        assertEquals(8, at30.length())

        val at31 = globalsCapabilityArray(31)
        assertEquals(9, at31.length())
        assertEquals("DISMISS_NOTIFICATION_SHADE", at31.getString(8))
    }
}

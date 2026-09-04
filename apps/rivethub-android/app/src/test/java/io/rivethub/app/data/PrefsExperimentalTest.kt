package io.rivethub.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrefsExperimentalTest {
    @Test
    fun `experimental flags default off`() {
        val p = Prefs()
        assertFalse(p.expFiles)
        assertFalse(p.expTasks)
        assertFalse(p.expWorkflows)
    }

    @Test
    fun `experimental flags persist through copy`() {
        val p = Prefs().copy(expFiles = true, expTasks = true, expWorkflows = false)
        assertTrue(p.expFiles)
        assertTrue(p.expTasks)
        assertFalse(p.expWorkflows)
        val round = p.copy()
        assertEquals(true, round.expFiles)
        assertEquals(true, round.expTasks)
        assertEquals(false, round.expWorkflows)
        val cleared = round.copy(expFiles = false, expTasks = false, expWorkflows = true)
        assertFalse(cleared.expFiles)
        assertFalse(cleared.expTasks)
        assertTrue(cleared.expWorkflows)
    }
}

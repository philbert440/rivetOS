package io.rivethub.app.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ToolbarKeyTest {
    @Test
    fun `label and sticky keys keep distinct ids`() {
        val esc = ToolbarKey.Label("esc", "Esc")
        val ctrl = ToolbarKey.Sticky("ctrl", "Ctrl")
        assertEquals("esc", esc.id)
        assertEquals("Esc", esc.label)
        assertEquals("ctrl", ctrl.id)
        assertNotEquals(esc.id, ctrl.id)
    }
}

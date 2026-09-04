package io.rivethub.app.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class RivetColorsTest {
    @Test
    fun `dark tokens match the brief table exactly`() {
        assertEquals("#ff0d1117", hex(RivetPalette.DarkBg))
        assertEquals("#ff131a22", hex(RivetPalette.DarkPanel))
        assertEquals("#ff1a232e", hex(RivetPalette.DarkPanel2))
        assertEquals("#ff253041", hex(RivetPalette.DarkLine))
        assertEquals("#ff161b22", hex(RivetPalette.DarkCodeBg))
        assertEquals("#ffe6edf3", hex(RivetPalette.DarkInk))
        assertEquals("#ff8b98a9", hex(RivetPalette.DarkInkDim))
        assertEquals("#ff34d399", hex(RivetPalette.DarkEm))
        assertEquals("#ff10b981", hex(RivetPalette.DarkEmDim))
        assertEquals("#fff87171", hex(RivetPalette.DarkRed))
        assertEquals("#fffbbf24", hex(RivetPalette.DarkWarn))
        assertEquals("#ff79c0ff", hex(RivetPalette.DarkLink))
        assertEquals("#ffd0d0d0", hex(RivetPalette.DarkAssistant))
        assertEquals("#0b34d399", hex(RivetPalette.DarkGridLine))
    }

    @Test
    fun `light tokens match the brief table exactly`() {
        assertEquals("#fff6f4ee", hex(RivetPalette.LightBg))
        assertEquals("#fffdfcf8", hex(RivetPalette.LightPanel))
        assertEquals("#ffeae7dd", hex(RivetPalette.LightPanel2))
        assertEquals("#ffd6d1c2", hex(RivetPalette.LightLine))
        assertEquals("#ffefede5", hex(RivetPalette.LightCodeBg))
        assertEquals("#ff20293a", hex(RivetPalette.LightInk))
        assertEquals("#ff5b6879", hex(RivetPalette.LightInkDim))
        assertEquals("#ff059669", hex(RivetPalette.LightEm))
        assertEquals("#ff10b981", hex(RivetPalette.LightEmDim))
        assertEquals("#ffdc2626", hex(RivetPalette.LightRed))
        assertEquals("#ffb45309", hex(RivetPalette.LightWarn))
        assertEquals("#ff0969da", hex(RivetPalette.LightLink))
        assertEquals("#ff3c4756", hex(RivetPalette.LightAssistant))
        assertEquals("#12059669", hex(RivetPalette.LightGridLine))
    }

    @Test
    fun `dark and light have no identical pair except emDim`() {
        val pairs = listOf(
            "bg" to (RivetPalette.DarkBg to RivetPalette.LightBg),
            "panel" to (RivetPalette.DarkPanel to RivetPalette.LightPanel),
            "panel2" to (RivetPalette.DarkPanel2 to RivetPalette.LightPanel2),
            "line" to (RivetPalette.DarkLine to RivetPalette.LightLine),
            "codeBg" to (RivetPalette.DarkCodeBg to RivetPalette.LightCodeBg),
            "ink" to (RivetPalette.DarkInk to RivetPalette.LightInk),
            "inkDim" to (RivetPalette.DarkInkDim to RivetPalette.LightInkDim),
            "em" to (RivetPalette.DarkEm to RivetPalette.LightEm),
            "emDim" to (RivetPalette.DarkEmDim to RivetPalette.LightEmDim),
            "red" to (RivetPalette.DarkRed to RivetPalette.LightRed),
            "warn" to (RivetPalette.DarkWarn to RivetPalette.LightWarn),
            "link" to (RivetPalette.DarkLink to RivetPalette.LightLink),
            "assistant" to (RivetPalette.DarkAssistant to RivetPalette.LightAssistant),
            "gridLine" to (RivetPalette.DarkGridLine to RivetPalette.LightGridLine),
        )
        for ((name, pair) in pairs) {
            if (name == "emDim") {
                assertEquals("emDim is the shared pair", pair.first, pair.second)
            } else {
                assertNotEquals("$name must differ across themes", pair.first, pair.second)
            }
        }
    }

    @Test
    fun `assistant differs from ink in each theme`() {
        assertNotEquals("light assistant must differ from ink", RivetPalette.LightInk, RivetPalette.LightAssistant)
        assertNotEquals("dark assistant must differ from ink", RivetPalette.DarkInk, RivetPalette.DarkAssistant)
        assertNotEquals(RivetPalette.DarkPanel, RivetPalette.DarkBg)
    }

    private fun hex(argb: Long): String = "#" + java.lang.Long.toHexString(argb).padStart(8, '0')
}

package io.rivethub.app.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class RivetColorsTest {
    @Test
    fun `dark tokens match the brief table exactly`() {
        assertEquals("#0d1117", hex(RivetPalette.DarkBg))
        assertEquals("#131a22", hex(RivetPalette.DarkPanel))
        assertEquals("#1a232e", hex(RivetPalette.DarkPanel2))
        assertEquals("#253041", hex(RivetPalette.DarkLine))
        assertEquals("#161b22", hex(RivetPalette.DarkCodeBg))
        assertEquals("#e6edf3", hex(RivetPalette.DarkInk))
        assertEquals("#8b98a9", hex(RivetPalette.DarkInkDim))
        assertEquals("#34d399", hex(RivetPalette.DarkEm))
        assertEquals("#10b981", hex(RivetPalette.DarkEmDim))
        assertEquals("#f87171", hex(RivetPalette.DarkRed))
        assertEquals("#fbbf24", hex(RivetPalette.DarkWarn))
        assertEquals("#79c0ff", hex(RivetPalette.DarkLink))
        assertEquals("#d0d0d0", hex(RivetPalette.DarkAssistant))
    }

    @Test
    fun `light tokens match the brief table exactly`() {
        assertEquals("#f6f4ee", hex(RivetPalette.LightBg))
        assertEquals("#fdfcf8", hex(RivetPalette.LightPanel))
        assertEquals("#eae7dd", hex(RivetPalette.LightPanel2))
        assertEquals("#d6d1c2", hex(RivetPalette.LightLine))
        assertEquals("#efede5", hex(RivetPalette.LightCodeBg))
        assertEquals("#20293a", hex(RivetPalette.LightInk))
        assertEquals("#5b6879", hex(RivetPalette.LightInkDim))
        assertEquals("#059669", hex(RivetPalette.LightEm))
        assertEquals("#10b981", hex(RivetPalette.LightEmDim))
        assertEquals("#dc2626", hex(RivetPalette.LightRed))
        assertEquals("#b45309", hex(RivetPalette.LightWarn))
        assertEquals("#0969da", hex(RivetPalette.LightLink))
        assertEquals("#20293a", hex(RivetPalette.LightAssistant))
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
        )
        for ((name, pair) in pairs) {
            if (name == "emDim") {
                assertEquals("emDim is the shared pair", pair.first, pair.second)
            } else {
                assertNotEquals("$name must differ across themes", pair.first, pair.second)
            }
        }
    }

    private fun hex(argb: Long): String {
        val rgb = (argb and 0xFFFFFFL).toInt()
        return "#" + rgb.toString(16).padStart(6, '0')
    }
}

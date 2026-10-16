package io.rivethub.app.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Test

/** Desktop parity: `lib/theme.ts` uiStyleFor and the theme.css material blocks. */
class UiStyleTest {
    @Test
    fun `explicit light and dark render material, system and omarchy classic`() {
        assertEquals(UiStyle.Material, uiStyleFor(ThemeMode.Light))
        assertEquals(UiStyle.Material, uiStyleFor(ThemeMode.Dark))
        assertEquals(UiStyle.Classic, uiStyleFor(ThemeMode.System))
        assertEquals(UiStyle.Classic, uiStyleFor(ThemeMode.Omarchy))
    }

    @Test
    fun `material dark tokens match theme css`() {
        assertEquals("#ff0f1512", hex(RivetPalette.MaterialDarkBg))
        assertEquals("#ff141a17", hex(RivetPalette.MaterialDarkPanel))
        assertEquals("#ff181e1b", hex(RivetPalette.MaterialDarkSurface))
        assertEquals("#ff232a26", hex(RivetPalette.MaterialDarkPanel2))
        assertEquals("#ff353d39", hex(RivetPalette.MaterialDarkLine))
        assertEquals("#ffdee4df", hex(RivetPalette.MaterialDarkInk))
        assertEquals("#ff6cdbac", hex(RivetPalette.MaterialDarkEm))
        assertEquals("#ff003825", hex(RivetPalette.MaterialDarkOnEm))
        assertEquals("#ff1f4535", hex(RivetPalette.MaterialDarkEmContainer))
        assertEquals("#ffa6f2cd", hex(RivetPalette.MaterialDarkOnEmContainer))
    }

    @Test
    fun `material light tokens match theme css`() {
        assertEquals("#ffe9f0eb", hex(RivetPalette.MaterialLightBg))
        assertEquals("#fff2f7f3", hex(RivetPalette.MaterialLightPanel))
        assertEquals("#fffbfdfb", hex(RivetPalette.MaterialLightSurface))
        assertEquals("#ffe4ebe6", hex(RivetPalette.MaterialLightPanel2))
        assertEquals("#ffc6d0c9", hex(RivetPalette.MaterialLightLine))
        assertEquals("#ff171d1a", hex(RivetPalette.MaterialLightInk))
        assertEquals("#ff006c4c", hex(RivetPalette.MaterialLightEm))
        assertEquals("#ffffffff", hex(RivetPalette.MaterialLightOnEm))
        assertEquals("#ffc4ecd8", hex(RivetPalette.MaterialLightEmContainer))
        assertEquals("#ff002114", hex(RivetPalette.MaterialLightOnEmContainer))
    }

    private fun hex(argb: Long): String = "#" + java.lang.Long.toHexString(argb).padStart(8, '0')
}

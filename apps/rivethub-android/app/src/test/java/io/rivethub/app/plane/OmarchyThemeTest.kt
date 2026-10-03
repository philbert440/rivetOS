package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OmarchyThemeTest {
    /**
     * Web reference: `omarchyAppTokens(omarchyPresetColors(id))` from
     * apps/rivethub-web/src/lib (mode, bg, panel, panel2, line, ink, inkDim,
     * em, emDim, red, warn, link, assistant). The phone must paint every
     * preset exactly as the browser does.
     */
    private val web = mapOf(
        "tokyo-night" to listOf("dark", "#1a1b26", "#1e202d", "#24283b", "#383d52", "#a9b1d6", "#5e6791", "#7aa2f7", "#6280c3", "#f7768e", "#eb927b", "#7aa2f7", "#b4bee6"),
        "catppuccin" to listOf("dark", "#1e1e2e", "#252536", "#313244", "#484b5e", "#cdd6f4", "#6c7086", "#89b4fa", "#6e8fc7", "#f38ba8", "#f6b6ab", "#89b4fa", "#bac2de"),
        "catppuccin-latte" to listOf("light", "#eff1f5", "#f9f9fb", "#d7d8dc", "#c2c3cb", "#4c4f69", "#878a9d", "#1e66f5", "#5289f5", "#d20f39", "#d84e2b", "#1e66f5", "#5c5f77"),
        "gruvbox" to listOf("dark", "#282828", "#2f2e2d", "#3c3836", "#534c45", "#d4be98", "#7c6f64", "#7daea3", "#688d84", "#ea6962", "#e1875c", "#7daea3", "#bdae93"),
        "rose-pine" to listOf("light", "#faf4ed", "#fdfbf8", "#e1dbd5", "#ccc6c7", "#575279", "#8c879d", "#56949f", "#7facb3", "#b4637a", "#b45309", "#56949f", "#6e6a86"),
        "everforest" to listOf("dark", "#2d353b", "#2f393e", "#343f44", "#4c5353", "#d3c6aa", "#7d7e79", "#7fbbb3", "#6b9a95", "#e67e80", "#e09d7f", "#7fbbb3", "#9da9a0"),
        "kanagawa" to listOf("dark", "#1f1f28", "#202634", "#223249", "#3e4b5a", "#dcd7ba", "#727169", "#dcd7ba", "#ada996", "#c34043", "#c17158", "#7e9cd8", "#c8c093"),
        "matte-black" to listOf("dark", "#121212", "#161616", "#1e1e1e", "#363636", "#bebebe", "#696969", "#e68e0d", "#b16f0e", "#d35f5f", "#c63d3d", "#e68e0d", "#8a8a8d"),
        "nord" to listOf("dark", "#2e3440", "#333946", "#3b4252", "#535969", "#d8dee9", "#7b8594", "#81a1c1", "#6c86a1", "#bf616a", "#d5967a", "#81a1c1", "#adb5c4"),
        "osaka-jade" to listOf("dark", "#111c18", "#17251f", "#23372b", "#3b4c3b", "#c1c497", "#81b8a8", "#509475", "#40765e", "#ff5345", "#a2734b", "#509475", "#d6d5bc"),
        "ristretto" to listOf("dark", "#2c2525", "#322927", "#3d2f2a", "#564945", "#e6d9db", "#7e7475", "#f38d70", "#c1735d", "#fd6883", "#fb9a77", "#f38d70", "#c3b7b8"),
        "flexoki-light" to listOf("light", "#fffcf0", "#fffef9", "#e5e2d8", "#c5c2ba", "#100f0f", "#878580", "#205ea6", "#5886b9", "#d14d41", "#d0772b", "#205ea6", "#403e3c"),
        "ethereal" to listOf("dark", "#060b1e", "#0b1028", "#131a3a", "#36354b", "#ffcead", "#6d7db6", "#7d82d9", "#5f64aa", "#ed5b5a", "#eb8b54", "#7d82d9", "#c9b8a6"),
        "hackerman" to listOf("dark", "#0b0c16", "#0f101c", "#151828", "#333948", "#ddf7ff", "#6a6e95", "#82fb9c", "#64bf7b", "#50f872", "#50f7a3", "#829dd4", "#b5c5db"),
    )

    @Test fun `every preset maps onto the same tokens as the web`() {
        assertEquals(web.keys, OMARCHY_PRESETS.map { it.id }.toSet())
        for ((id, want) in web) {
            val t = omarchyPresetTokens(id)!!
            val got = listOf(
                if (t.dark) "dark" else "light",
                t.bg, t.panel, t.panel2, t.line, t.ink, t.inkDim,
                t.em, t.emDim, t.red, t.warn, t.link, t.assistant,
            )
            assertEquals(id, want, got)
        }
    }

    @Test fun `the default preset exists`() {
        assertEquals(1, OMARCHY_PRESETS.count { it.id == DEFAULT_OMARCHY_PRESET })
    }

    @Test fun `unknown ids and incomplete toml give nothing`() {
        assertNull(omarchyPresetTokens("no-such-theme"))
        assertNull(parseOmarchyColors("background = \"#000000\"\nforeground = \"#ffffff\""))
    }

    @Test fun `hex parsing accepts rgb and rrggbb only`() {
        assertEquals("#aabbcc", parseHexColor("#ABC"))
        assertEquals("#0d1117", parseHexColor(" #0D1117 "))
        assertNull(parseHexColor("0d1117"))
        assertNull(parseHexColor("#0d11"))
        assertEquals(0xFF0D1117L, hexToArgb("#0d1117"))
    }

    @Test fun `mixing rounds like the web`() {
        assertEquals("#808080", mixHex("#000000", "#ffffff", 0.5))
        assertEquals("#000000", mixHex("#000000", "#ffffff", -1.0))
    }
}

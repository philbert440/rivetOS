package io.rivethub.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import io.rivethub.app.plane.OmarchyTokens
import io.rivethub.app.plane.hexToArgb

/**
 * ARGB longs for the desktop RivetHub tokens. JVM tests assert these values
 * without touching Compose `Color` / `toArgb()` (no Android runtime on the
 * unit-test classpath). The composable layer builds `Color` from them.
 */
object RivetPalette {
    const val DarkBg = 0xFF0D1117L
    const val DarkPanel = 0xFF131A22L
    const val DarkPanel2 = 0xFF1A232EL
    const val DarkLine = 0xFF253041L
    const val DarkCodeBg = 0xFF161B22L
    const val DarkInk = 0xFFE6EDF3L
    const val DarkInkDim = 0xFF8B98A9L
    const val DarkEm = 0xFF34D399L
    const val DarkEmDim = 0xFF10B981L
    const val DarkRed = 0xFFF87171L
    const val DarkWarn = 0xFFFBBF24L
    const val DarkLink = 0xFF79C0FFL
    const val DarkAssistant = 0xFFD0D0D0L

    const val LightBg = 0xFFF6F4EEL
    const val LightPanel = 0xFFFDFCF8L
    const val LightPanel2 = 0xFFEAE7DDL
    const val LightLine = 0xFFD6D1C2L
    const val LightCodeBg = 0xFFEFEDE5L
    const val LightInk = 0xFF20293AL
    const val LightInkDim = 0xFF5B6879L
    const val LightEm = 0xFF059669L
    const val LightEmDim = 0xFF10B981L
    const val LightRed = 0xFFDC2626L
    const val LightWarn = 0xFFB45309L
    const val LightLink = 0xFF0969DAL
    const val LightAssistant = 0xFF3C4756L

    // Material style (an explicit Light or Dark choice) — theme.css
    // html[data-style='material'] blocks: tonal surfaces from the emerald seed.
    const val MaterialDarkBg = 0xFF0F1512L
    const val MaterialDarkPanel = 0xFF141A17L
    const val MaterialDarkSurface = 0xFF181E1BL
    const val MaterialDarkPanel2 = 0xFF232A26L
    const val MaterialDarkLine = 0xFF353D39L
    const val MaterialDarkCodeBg = 0xFF111714L
    const val MaterialDarkInk = 0xFFDEE4DFL
    const val MaterialDarkInkDim = 0xFFA7B2ABL
    const val MaterialDarkEm = 0xFF6CDBACL
    const val MaterialDarkEmDim = 0xFF4FC497L
    const val MaterialDarkOnEm = 0xFF003825L
    const val MaterialDarkEmContainer = 0xFF1F4535L
    const val MaterialDarkOnEmContainer = 0xFFA6F2CDL
    const val MaterialDarkRed = 0xFFFFB4ABL
    const val MaterialDarkWarn = 0xFFF5C56BL
    const val MaterialDarkLink = 0xFF8ECBFFL
    const val MaterialDarkAssistant = 0xFFD3DBD5L

    const val MaterialLightBg = 0xFFE9F0EBL
    const val MaterialLightPanel = 0xFFF2F7F3L
    const val MaterialLightSurface = 0xFFFBFDFBL
    const val MaterialLightPanel2 = 0xFFE4EBE6L
    const val MaterialLightLine = 0xFFC6D0C9L
    const val MaterialLightCodeBg = 0xFFEDF2EEL
    const val MaterialLightInk = 0xFF171D1AL
    const val MaterialLightInkDim = 0xFF56615BL
    const val MaterialLightEm = 0xFF006C4CL
    const val MaterialLightEmDim = 0xFF00573DL
    const val MaterialLightOnEm = 0xFFFFFFFFL
    const val MaterialLightEmContainer = 0xFFC4ECD8L
    const val MaterialLightOnEmContainer = 0xFF002114L
    const val MaterialLightRed = 0xFFBA1A1AL
    const val MaterialLightWarn = 0xFF8A5100L
    const val MaterialLightLink = 0xFF0B57D0L
    const val MaterialLightAssistant = 0xFF2C3530L
}

@Immutable
data class RivetColors(
    val bg: Color,
    val panel: Color,
    val panel2: Color,
    val line: Color,
    val codeBg: Color,
    val ink: Color,
    val inkDim: Color,
    val em: Color,
    val emDim: Color,
    val red: Color,
    val warn: Color,
    val link: Color,
    val assistant: Color,
    /** `--color-surface`: the page tile. Classic paints it as [panel]. */
    val surface: Color = panel,
    /** `--color-on-em`: ink on a filled accent (primary button, send). */
    val onEm: Color = bg,
    /** `--color-em-container`: selected fill (active nav, open conversation). */
    val emContainer: Color = panel2,
    /** `--color-on-em-container`: ink on [emContainer]. */
    val onEmContainer: Color = em,
    /** The phone page behind a screen's content. Classic shows [bg] (web
     *  `classic:bg-transparent` at phone width); Material the [surface] tile. */
    val page: Color = bg,
)

private fun token(argb: Long): Color = Color(argb)

val RivetDark = RivetColors(
    bg = token(RivetPalette.DarkBg),
    panel = token(RivetPalette.DarkPanel),
    panel2 = token(RivetPalette.DarkPanel2),
    line = token(RivetPalette.DarkLine),
    codeBg = token(RivetPalette.DarkCodeBg),
    ink = token(RivetPalette.DarkInk),
    inkDim = token(RivetPalette.DarkInkDim),
    em = token(RivetPalette.DarkEm),
    emDim = token(RivetPalette.DarkEmDim),
    red = token(RivetPalette.DarkRed),
    warn = token(RivetPalette.DarkWarn),
    link = token(RivetPalette.DarkLink),
    assistant = token(RivetPalette.DarkAssistant),
)

val RivetLight = RivetColors(
    bg = token(RivetPalette.LightBg),
    panel = token(RivetPalette.LightPanel),
    panel2 = token(RivetPalette.LightPanel2),
    line = token(RivetPalette.LightLine),
    codeBg = token(RivetPalette.LightCodeBg),
    ink = token(RivetPalette.LightInk),
    inkDim = token(RivetPalette.LightInkDim),
    em = token(RivetPalette.LightEm),
    emDim = token(RivetPalette.LightEmDim),
    red = token(RivetPalette.LightRed),
    warn = token(RivetPalette.LightWarn),
    link = token(RivetPalette.LightLink),
    assistant = token(RivetPalette.LightAssistant),
)

val MaterialDark = RivetColors(
    bg = token(RivetPalette.MaterialDarkBg),
    panel = token(RivetPalette.MaterialDarkPanel),
    panel2 = token(RivetPalette.MaterialDarkPanel2),
    line = token(RivetPalette.MaterialDarkLine),
    codeBg = token(RivetPalette.MaterialDarkCodeBg),
    ink = token(RivetPalette.MaterialDarkInk),
    inkDim = token(RivetPalette.MaterialDarkInkDim),
    em = token(RivetPalette.MaterialDarkEm),
    emDim = token(RivetPalette.MaterialDarkEmDim),
    red = token(RivetPalette.MaterialDarkRed),
    warn = token(RivetPalette.MaterialDarkWarn),
    link = token(RivetPalette.MaterialDarkLink),
    assistant = token(RivetPalette.MaterialDarkAssistant),
    surface = token(RivetPalette.MaterialDarkSurface),
    onEm = token(RivetPalette.MaterialDarkOnEm),
    emContainer = token(RivetPalette.MaterialDarkEmContainer),
    onEmContainer = token(RivetPalette.MaterialDarkOnEmContainer),
    page = token(RivetPalette.MaterialDarkSurface),
)

val MaterialLight = RivetColors(
    bg = token(RivetPalette.MaterialLightBg),
    panel = token(RivetPalette.MaterialLightPanel),
    panel2 = token(RivetPalette.MaterialLightPanel2),
    line = token(RivetPalette.MaterialLightLine),
    codeBg = token(RivetPalette.MaterialLightCodeBg),
    ink = token(RivetPalette.MaterialLightInk),
    inkDim = token(RivetPalette.MaterialLightInkDim),
    em = token(RivetPalette.MaterialLightEm),
    emDim = token(RivetPalette.MaterialLightEmDim),
    red = token(RivetPalette.MaterialLightRed),
    warn = token(RivetPalette.MaterialLightWarn),
    link = token(RivetPalette.MaterialLightLink),
    assistant = token(RivetPalette.MaterialLightAssistant),
    surface = token(RivetPalette.MaterialLightSurface),
    onEm = token(RivetPalette.MaterialLightOnEm),
    emContainer = token(RivetPalette.MaterialLightEmContainer),
    onEmContainer = token(RivetPalette.MaterialLightOnEmContainer),
    page = token(RivetPalette.MaterialLightSurface),
)

/** An Omarchy palette's tokens (`plane/OmarchyTheme.kt`) as app colors. */
fun rivetColorsFrom(t: OmarchyTokens) = RivetColors(
    bg = token(hexToArgb(t.bg)),
    panel = token(hexToArgb(t.panel)),
    panel2 = token(hexToArgb(t.panel2)),
    line = token(hexToArgb(t.line)),
    codeBg = token(hexToArgb(t.codeBg)),
    ink = token(hexToArgb(t.ink)),
    inkDim = token(hexToArgb(t.inkDim)),
    em = token(hexToArgb(t.em)),
    emDim = token(hexToArgb(t.emDim)),
    red = token(hexToArgb(t.red)),
    warn = token(hexToArgb(t.warn)),
    link = token(hexToArgb(t.link)),
    assistant = token(hexToArgb(t.assistant)),
)

val LocalRivetColors = staticCompositionLocalOf { RivetDark }

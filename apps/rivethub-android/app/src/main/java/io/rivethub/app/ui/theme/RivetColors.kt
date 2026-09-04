package io.rivethub.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

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

    /** Default-button label on `em` fills — desktop `text-bg`. */
    const val OnEm = 0xFF0D1117L

    /** `--grid-line`: rgba(52,211,153,0.045) dark / rgba(5,150,105,0.07) light. */
    const val DarkGridLine = 0x0B34D399L
    const val LightGridLine = 0x12059669L
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
    val gridLine: Color,
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
    gridLine = token(RivetPalette.DarkGridLine),
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
    gridLine = token(RivetPalette.LightGridLine),
)

val LocalRivetColors = staticCompositionLocalOf { RivetDark }

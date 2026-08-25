package dev.rivetos.bots.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Light palette — the Grok Bot look: white paper, near-black ink, grey panels.
val Ink = Color(0xFF111114)
val InkDim = Color(0xFF8A8A8E)
val Paper = Color(0xFFFFFFFF)
val Panel = Color(0xFFF2F2F4)
val Line = Color(0xFFE6E6EA)
val Emerald = Color(0xFF34D399)
val Danger = Color(0xFFE5484D)

// Dark palette — the RivetOS family look: charcoal canvas, lifted panels, emerald accent.
val NightPaper = Color(0xFF0D1117)
val NightPanel = Color(0xFF131A22)
val NightRaised = Color(0xFF1C2630)
val NightInk = Color(0xFFE6EDF3)
val NightDim = Color(0xFF8B98A5)
val NightLine = Color(0xFF2A3542)
val NightDanger = Color(0xFFF08A8E)

// ComputerScreen's always-dark den room keeps its own constants (not theme-driven).
val Dark = Color(0xFF0C0C0E)
val DarkPanel = Color(0xFF1C1C1F)
val DarkInk = Color(0xFFE6E6EA)
val DarkDim = Color(0xFF8A8A92)

private val Light = lightColorScheme(
    primary = Ink,
    onPrimary = Paper,
    background = Paper,
    onBackground = Ink,
    surface = Paper,
    onSurface = Ink,
    surfaceVariant = Panel,
    onSurfaceVariant = InkDim,
    outline = Line,
    outlineVariant = Line,
    secondaryContainer = Panel,
    onSecondaryContainer = Ink,
    tertiary = Emerald,
    error = Danger,
    // User bubbles / primary buttons invert the page: black pill on white paper.
    inverseSurface = Ink,
    inverseOnSurface = Paper,
)

private val Night = darkColorScheme(
    primary = Emerald,
    onPrimary = NightPaper,
    background = NightPaper,
    onBackground = NightInk,
    surface = NightPaper,
    onSurface = NightInk,
    surfaceVariant = NightPanel,
    onSurfaceVariant = NightDim,
    outline = NightLine,
    outlineVariant = NightLine,
    secondaryContainer = NightRaised,
    onSecondaryContainer = NightInk,
    tertiary = Emerald,
    error = NightDanger,
    // Same inversion as light: user bubbles become light ink on the charcoal page.
    inverseSurface = NightInk,
    inverseOnSurface = NightPaper,
)

@Composable
fun RivetBotsTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) Night else Light,
        typography = Typography(),
        content = content,
    )
}

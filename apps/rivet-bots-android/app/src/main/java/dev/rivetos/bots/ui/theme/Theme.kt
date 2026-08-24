package dev.rivetos.bots.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Ink = Color(0xFF111114)
val InkDim = Color(0xFF8A8A8E)
val Paper = Color(0xFFFFFFFF)
val Panel = Color(0xFFF2F2F4)
val Line = Color(0xFFE6E6EA)
val Emerald = Color(0xFF34D399)
val Danger = Color(0xFFE5484D)
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
)

@Composable
fun RivetBotsTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Light, typography = Typography(), content = content)
}

package dev.rivetos.team.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Em = Color(0xFF34D399)
private val Bg = Color(0xFF0D1117)
private val Panel = Color(0xFF131A22)
private val Ink = Color(0xFFE6EDF3)
private val InkDim = Color(0xFF8B98A9)

private val Scheme = darkColorScheme(
    primary = Em,
    onPrimary = Bg,
    background = Bg,
    onBackground = Ink,
    surface = Panel,
    onSurface = Ink,
    onSurfaceVariant = InkDim,
    outline = Color(0xFF253041),
)

@Composable
fun RivetTeamTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, content = content)
}

package dev.rivetos.team.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Messaging-app chrome (near-black, like Grok Bot / OpenMausBot) + Rivet emerald. */
internal object TeamColors {
    val App = Color(0xFF070707)
    val Panel = Color(0xFF111111)
    val Raised = Color(0xFF2F2F2F)
    val Card = Color(0xFF262626)
    val Inset = Color(0xFF191919)
    val Hairline = Color(0xFF333333)
    val Ink = Color(0xFFFCFCFC)
    val InkDim = Color(0x99FCFCFC)
    val Em = Color(0xFF34D399)
    val BubbleUser = Color(0xFF5A5A5A)
}

private val Scheme = darkColorScheme(
    primary = TeamColors.Em,
    onPrimary = TeamColors.App,
    background = TeamColors.App,
    onBackground = TeamColors.Ink,
    surface = TeamColors.Panel,
    onSurface = TeamColors.Ink,
    onSurfaceVariant = TeamColors.InkDim,
    outline = TeamColors.Hairline,
)

@Composable
fun RivetTeamTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, content = content)
}

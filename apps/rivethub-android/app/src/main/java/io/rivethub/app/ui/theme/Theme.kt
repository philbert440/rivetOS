package io.rivethub.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Light palette — the Grok Bot look: white paper, near-black ink, grey panels.
// Kept for ComputerScreen / BlobAvatar until M3b drops the Grok-Bot screens.
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

@Composable
fun RivetBotsTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) =
    RivetTheme(if (darkTheme) ThemeMode.Dark else ThemeMode.Light, content)

package io.rivethub.app.ui.components

import androidx.compose.ui.graphics.Color
import io.rivethub.app.plane.ACCENT_LOCAL
import io.rivethub.app.plane.parseAccentArgb

fun rivetHexColor(hex: String): Color {
    val argb = parseAccentArgb(hex) ?: parseAccentArgb(ACCENT_LOCAL) ?: 0xFF34D399L
    return Color(argb)
}

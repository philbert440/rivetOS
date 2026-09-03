package io.rivethub.app.ui.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import io.rivethub.app.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Desktop fonts are DM Sans + JetBrains Mono. Variable TTFs are not in this
 * tree — families fall back to the system until the integrator drops
 * `dm_sans_variable.ttf` and `jetbrains_mono_variable.ttf` in `res/font/`
 * and wires `Font(R.font.…)`.
 */
object RivetFonts {
    /** DM Sans (variable) — desktop `--font-sans`; system sans fallback is implicit. */
    val Sans: FontFamily = FontFamily(Font(R.font.dm_sans_variable))
    /** JetBrains Mono (variable) — desktop `--font-mono`. */
    val Mono: FontFamily = FontFamily(Font(R.font.jetbrains_mono_variable))
}

object RivetType {
    val body = TextStyle(
        fontFamily = RivetFonts.Sans,
        fontSize = 15.sp,
        fontWeight = FontWeight.Normal,
    )
    val meta = TextStyle(
        fontFamily = RivetFonts.Sans,
        fontSize = 13.sp,
        fontWeight = FontWeight.Normal,
    )
    val monoPill = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 11.sp,
        fontWeight = FontWeight.Normal,
    )
    val title = TextStyle(
        fontFamily = RivetFonts.Sans,
        fontSize = 15.sp,
        fontWeight = FontWeight.SemiBold,
    )
    val screenTitle = TextStyle(
        fontFamily = RivetFonts.Sans,
        fontSize = 22.sp,
        fontWeight = FontWeight.SemiBold,
    )
    val monoTerminal = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.Normal,
    )
}

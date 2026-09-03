package io.rivethub.app.ui.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import io.rivethub.app.R

/**
 * Desktop fonts are DM Sans + JetBrains Mono, shipped as variable TTFs
 * in `res/font/`. Compose only moves `wght`/`opsz` when each weight is
 * registered with [FontVariation.Settings]; a bare `Font(resId)` would
 * pin the default named instance (DM Sans opsz 9 / wght 400) and
 * faux-bold every SemiBold request.
 *
 * One `opsz 14` family is the v1 compromise (body 15 / title 15 /
 * screenTitle 22). 700 is registered on both faces for M4 ANSI bold.
 */
object RivetFonts {
    val Sans: FontFamily = FontFamily(sans(400, 14f), sans(500, 14f), sans(600, 14f), sans(700, 14f))
    val Mono: FontFamily = FontFamily(mono(400), mono(500), mono(700))
}

private fun sans(w: Int, opsz: Float) = Font(
    R.font.dm_sans_variable,
    weight = FontWeight(w),
    variationSettings = FontVariation.Settings(
        FontVariation.weight(w),
        FontVariation.Setting("opsz", opsz),
    ),
)

private fun mono(w: Int) = Font(
    R.font.jetbrains_mono_variable,
    weight = FontWeight(w),
    variationSettings = FontVariation.Settings(FontVariation.weight(w)),
)

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

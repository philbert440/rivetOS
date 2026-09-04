@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package io.rivethub.app.ui.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.rivethub.app.R

/**
 * Desktop fonts are DM Sans + JetBrains Mono, shipped as variable TTFs
 * in `res/font/`. Compose only moves `wght`/`opsz` when each weight is
 * registered with [FontVariation.Settings]; a bare `Font(resId)` would
 * pin the default named instance (DM Sans opsz 9 / wght 400) and
 * faux-bold every SemiBold request.
 *
 * Scale matches the D1a translation table (`text-lg` 18 / `text-sm` 14 /
 * `text-xs` 13). 700 is registered on both faces for M4 ANSI bold.
 */
object RivetFonts {
    val Sans: FontFamily = FontFamily(sans(400, 14f), sans(500, 14f), sans(600, 14f), sans(700, 14f))
    val Mono: FontFamily = FontFamily(mono(400), mono(500), mono(600), mono(700))
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
    val lg = TextStyle(
        fontFamily = RivetFonts.Sans,
        fontSize = 18.sp,
        fontWeight = FontWeight.SemiBold,
    )
    val sm = TextStyle(
        fontFamily = RivetFonts.Sans,
        fontSize = 14.sp,
        fontWeight = FontWeight.Normal,
    )
    val xs = TextStyle(
        fontFamily = RivetFonts.Sans,
        fontSize = 13.sp,
        fontWeight = FontWeight.Normal,
    )
    val mono11 = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 11.sp,
        fontWeight = FontWeight.Normal,
    )
    val mono10 = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 10.sp,
        fontWeight = FontWeight.Normal,
    )
    val mono9 = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 9.sp,
        fontWeight = FontWeight.Normal,
    )
    val mono14 = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 14.sp,
        fontWeight = FontWeight.Normal,
    )
    val mono12 = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 12.sp,
        fontWeight = FontWeight.Normal,
    )
    val monoSmSemibold = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.025.em,
    )
    val brand = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.025.em,
    )

    /** Aliases for screens not yet on the D1a scale (chat, composer, terminal). */
    val body = sm
    val meta = xs
    val monoPill = mono11
    val title = sm.copy(fontWeight = FontWeight.SemiBold)
    val screenTitle = lg
    val monoTerminal = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.Normal,
    )
}

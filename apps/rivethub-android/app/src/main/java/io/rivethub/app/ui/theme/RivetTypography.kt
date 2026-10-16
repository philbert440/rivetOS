@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package io.rivethub.app.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.rivethub.app.R

/**
 * Classic: one monospace face for the whole UI, as Omarchy (and the desktop
 * redesign, theme.css `--font-sans: 'JetBrains Mono'`) does — [RivetFonts.Sans]
 * is JetBrains Mono. Material: [RivetFonts.Sans] is the platform sans (Roboto,
 * desktop's Roboto Flex fallback); JetBrains Mono stays for code, paths, ids
 * and the terminal, as on desktop.
 * The variable TTF lives in `res/font/`. Compose only moves `wght` when each
 * weight is registered with [FontVariation.Settings]; a bare `Font(resId)`
 * would pin the default named instance (wght 400) and faux-bold every
 * SemiBold request.
 *
 * Scale matches the D1a translation table (`text-lg` 18 / `text-sm` 14 /
 * `text-xs` 13). 700 is registered for M4 ANSI bold, 800 for the
 * `rivethub` wordmark and `rh` mark (`font-extrabold`).
 */
object RivetFonts {
    val Mono: FontFamily = FontFamily(mono(400), mono(500), mono(600), mono(700), mono(800))
    val Sans: FontFamily
        @Composable @ReadOnlyComposable get() =
            if (LocalUiStyle.current == UiStyle.Material) FontFamily.SansSerif else Mono
}

private fun mono(w: Int) = Font(
    R.font.jetbrains_mono_variable,
    weight = FontWeight(w),
    variationSettings = FontVariation.Settings(FontVariation.weight(w)),
)

object RivetType {
    val lg: TextStyle
        @Composable @ReadOnlyComposable get() = TextStyle(
            fontFamily = RivetFonts.Sans,
            fontSize = 18.sp,
            fontWeight = FontWeight.SemiBold,
        )
    val sm: TextStyle
        @Composable @ReadOnlyComposable get() = TextStyle(
            fontFamily = RivetFonts.Sans,
            fontSize = 14.sp,
            fontWeight = FontWeight.Normal,
        )
    val xs: TextStyle
        @Composable @ReadOnlyComposable get() = TextStyle(
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
    val body: TextStyle
        @Composable @ReadOnlyComposable get() = sm
    val meta: TextStyle
        @Composable @ReadOnlyComposable get() = xs
    val monoPill = mono11
    val title: TextStyle
        @Composable @ReadOnlyComposable get() = sm.copy(fontWeight = FontWeight.SemiBold)
    val screenTitle: TextStyle
        @Composable @ReadOnlyComposable get() = lg
    val monoTerminal = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.Normal,
    )
}

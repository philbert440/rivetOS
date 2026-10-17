package io.rivethub.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import io.rivethub.app.plane.DEFAULT_OMARCHY_PRESET
import io.rivethub.app.plane.omarchyPresetTokens

val LocalUiFontScale = compositionLocalOf { 1f }

/** Settings → Appearance. [Omarchy] paints a built-in Omarchy palette (its own light/dark). */
enum class ThemeMode { System, Light, Dark, Omarchy }

/** The prefs `themeMode` string → [ThemeMode] (unknown → System). */
fun themeModeOf(pref: String?): ThemeMode = when (pref) {
    "light" -> ThemeMode.Light
    "dark" -> ThemeMode.Dark
    "omarchy" -> ThemeMode.Omarchy
    else -> ThemeMode.System
}

/**
 * The UI style a theme choice renders in — desktop `lib/theme.ts` uiStyleFor.
 * An explicit Light or Dark choice gets the rounded Material style; System and
 * Omarchy keep the square, mono classic style.
 */
enum class UiStyle { Classic, Material }

fun uiStyleFor(mode: ThemeMode): UiStyle =
    if (mode == ThemeMode.Light || mode == ThemeMode.Dark) UiStyle.Material else UiStyle.Classic

val LocalUiStyle = staticCompositionLocalOf { UiStyle.Classic }

/** What a theme choice paints: its colors, light/dark, and UI style. */
data class ResolvedTheme(val colors: RivetColors, val dark: Boolean, val style: UiStyle)

/** Colors, light/dark and style for a theme choice; [palette] is an Omarchy preset id. */
fun resolveRivetColors(mode: ThemeMode, palette: String?, systemDark: Boolean): ResolvedTheme {
    val style = uiStyleFor(mode)
    if (mode == ThemeMode.Omarchy) {
        val tokens = omarchyPresetTokens(palette ?: DEFAULT_OMARCHY_PRESET)
            ?: omarchyPresetTokens(DEFAULT_OMARCHY_PRESET)
        if (tokens != null) return ResolvedTheme(rivetColorsFrom(tokens), tokens.dark, style)
    }
    val dark = when (mode) {
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
        ThemeMode.System, ThemeMode.Omarchy -> systemDark
    }
    val colors = when (style) {
        UiStyle.Material -> if (dark) MaterialDark else MaterialLight
        UiStyle.Classic -> if (dark) RivetDark else RivetLight
    }
    return ResolvedTheme(colors, dark, style)
}

@Composable
private fun rivetMaterialTypography() = Typography(
    bodyLarge = RivetType.sm,
    bodyMedium = RivetType.xs,
    titleMedium = RivetType.title,
    titleLarge = RivetType.lg,
    labelSmall = RivetType.mono11,
    labelMedium = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 12.sp,
        fontWeight = FontWeight.Normal,
    ),
)

private fun scheme(c: RivetColors, dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c.em,
        onPrimary = c.onEm,
        background = c.page,
        onBackground = c.ink,
        surface = c.surface,
        onSurface = c.ink,
        surfaceVariant = c.panel2,
        onSurfaceVariant = c.inkDim,
        outline = c.line,
        outlineVariant = c.line,
        error = c.red,
        onError = c.bg,
        tertiary = c.warn,
        onTertiary = c.bg,
        inverseSurface = c.ink,
        inverseOnSurface = c.bg,
        secondary = c.em,
        onSecondary = c.onEm,
        secondaryContainer = c.emContainer,
        onSecondaryContainer = c.onEmContainer,
        primaryContainer = c.emContainer,
        onPrimaryContainer = c.onEmContainer,
        surfaceContainerLowest = c.bg,
        surfaceContainerLow = c.codeBg,
        surfaceContainer = c.panel,
        surfaceContainerHigh = c.panel2,
        surfaceContainerHighest = c.panel2,
        surfaceBright = c.panel2,
        surfaceDim = c.bg,
        surfaceTint = Color.Transparent,
        scrim = c.bg,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RivetTheme(
    mode: ThemeMode = ThemeMode.System,
    palette: String? = null,
    fontScale: Float = 1f,
    content: @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    val (colors, dark, style) = remember(mode, palette, systemDark) { resolveRivetColors(mode, palette, systemDark) }
    val current = LocalDensity.current
    // Keep the platform density (including non-linear font scaling) at M.
    val density = if (fontScale == 1f) current else Density(current.density, current.fontScale * fontScale)
    CompositionLocalProvider(
        LocalRivetColors provides colors,
        LocalUiStyle provides style,
        LocalUiFontScale provides LocalUiFontScale.current * fontScale,
        LocalRippleConfiguration provides RippleConfiguration(color = colors.ink.copy(alpha = 0.12f)),
    ) {
        MaterialTheme(
            colorScheme = scheme(colors, dark),
            typography = rivetMaterialTypography(),
        ) {
            // One structural position preserves remembered app state across text-size changes.
            CompositionLocalProvider(LocalDensity provides density, content = content)
        }
    }
}

object RivetTheme {
    val colors: RivetColors
        @Composable
        @ReadOnlyComposable
        get() = LocalRivetColors.current

    val style: UiStyle
        @Composable
        @ReadOnlyComposable
        get() = LocalUiStyle.current
}

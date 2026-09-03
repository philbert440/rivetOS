package io.rivethub.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

enum class ThemeMode { System, Light, Dark }

private val RivetMaterialTypography = Typography(
    bodyLarge = RivetType.body,
    bodyMedium = RivetType.meta,
    titleMedium = RivetType.title,
    titleLarge = RivetType.screenTitle,
    labelSmall = RivetType.monoPill,
    labelMedium = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = 12.sp,
        fontWeight = FontWeight.Normal,
    ),
)

private fun scheme(c: RivetColors, dark: Boolean) = if (dark) {
    darkColorScheme(
        primary = c.em,
        onPrimary = c.bg,
        background = c.bg,
        onBackground = c.ink,
        surface = c.panel,
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
        secondaryContainer = c.panel2,
        onSecondaryContainer = c.ink,
    )
} else {
    lightColorScheme(
        primary = c.em,
        onPrimary = c.bg,
        background = c.bg,
        onBackground = c.ink,
        surface = c.panel,
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
        secondaryContainer = c.panel2,
        onSecondaryContainer = c.ink,
    )
}

@Composable
fun RivetTheme(mode: ThemeMode = ThemeMode.System, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.System -> isSystemInDarkTheme()
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    }
    val colors = if (dark) RivetDark else RivetLight
    CompositionLocalProvider(LocalRivetColors provides colors) {
        MaterialTheme(
            colorScheme = scheme(colors, dark),
            typography = RivetMaterialTypography,
            content = content,
        )
    }
}

object RivetTheme {
    val colors: RivetColors
        @Composable
        @ReadOnlyComposable
        get() = LocalRivetColors.current
}

/** Always-dark-canvas ink used on `em` fills (PrimaryButton). */
val OnEm = Color(RivetPalette.OnEm)

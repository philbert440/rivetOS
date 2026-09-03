package io.rivethub.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp

enum class ThemeMode { System, Light, Dark }

private val RivetMaterialTypography = Typography(
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
        secondary = c.em,
        onSecondary = c.bg,
        secondaryContainer = c.panel2,
        onSecondaryContainer = c.ink,
        primaryContainer = c.panel2,
        onPrimaryContainer = c.em,
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
        secondary = c.em,
        onSecondary = c.bg,
        secondaryContainer = c.panel2,
        onSecondaryContainer = c.ink,
        primaryContainer = c.panel2,
        onPrimaryContainer = c.em,
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
fun RivetTheme(mode: ThemeMode = ThemeMode.System, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.System -> isSystemInDarkTheme()
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    }
    val colors = if (dark) RivetDark else RivetLight
    CompositionLocalProvider(
        LocalRivetColors provides colors,
        LocalRippleConfiguration provides RippleConfiguration(color = colors.ink.copy(alpha = 0.12f)),
    ) {
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

/** Desktop `text-bg` on `em` fills. */
val OnEm = Color(RivetPalette.OnEm)

/**
 * Desktop body blueprint grid: two 1px line grids every 32dp.
 * Apply on the app root over `bg`; surfaces above it use `panel`/`panel2` with alpha.
 */
fun Modifier.blueprintGrid(
    line: Color,
    step: Dp = Grid.step,
): Modifier = drawBehind {
    val s = step.toPx()
    if (s <= 0f) return@drawBehind
    val stroke = 1f
    var x = 0f
    while (x <= size.width) {
        drawLine(line, Offset(x, 0f), Offset(x, size.height), strokeWidth = stroke)
        x += s
    }
    var y = 0f
    while (y <= size.height) {
        drawLine(line, Offset(0f, y), Offset(size.width, y), strokeWidth = stroke)
        y += s
    }
}

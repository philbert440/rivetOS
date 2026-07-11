package dev.rivet.app.ui.theme.presets

import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import dev.rivet.app.R
import dev.rivet.app.ui.theme.PresetTheme

// Canonical Rivet brand: emerald-on-dark engineering scheme (philtompkins.com palette).
// Dark is the primary look. Accent #34d399 emerald on a green-tinted near-black canvas.
val RivetThemePreset by lazy {
    PresetTheme(
        id = "rivet",
        name = {
            Text(stringResource(id = R.string.theme_name_rivet))
        },
        standardLight = lightScheme,
        standardDark = darkScheme,
    )
}

// ---- Dark (primary) ----
private val primaryDark = Color(0xFF34D399)
private val onPrimaryDark = Color(0xFF003824)
private val primaryContainerDark = Color(0xFF115740)
private val onPrimaryContainerDark = Color(0xFFA8F5D4)
private val secondaryDark = Color(0xFFA7C3B3)
private val onSecondaryDark = Color(0xFF113223)
private val secondaryContainerDark = Color(0xFF354B40)
private val onSecondaryContainerDark = Color(0xFFC3E3D1)
private val tertiaryDark = Color(0xFF7DD3C0)
private val onTertiaryDark = Color(0xFF003730)
private val tertiaryContainerDark = Color(0xFF1F4D45)
private val onTertiaryContainerDark = Color(0xFF9FF0E0)
private val errorDark = Color(0xFFFFB4AB)
private val onErrorDark = Color(0xFF690005)
private val errorContainerDark = Color(0xFF93000A)
private val onErrorContainerDark = Color(0xFFFFDAD6)
private val backgroundDark = Color(0xFF101412)
private val onBackgroundDark = Color(0xFFE8EDE5)
private val surfaceDark = Color(0xFF101412)
private val onSurfaceDark = Color(0xFFE8EDE5)
private val surfaceVariantDark = Color(0xFF404A44)
private val onSurfaceVariantDark = Color(0xFF93A390)
private val outlineDark = Color(0xFF8A948C)
private val outlineVariantDark = Color(0xFF404A44)
private val scrimDark = Color(0xFF000000)
private val inverseSurfaceDark = Color(0xFFE8EDE5)
private val inverseOnSurfaceDark = Color(0xFF1A1F1A)
private val inversePrimaryDark = Color(0xFF059669)
private val surfaceDimDark = Color(0xFF101412)
private val surfaceBrightDark = Color(0xFF353A37)
private val surfaceContainerLowestDark = Color(0xFF0A0E0C)
private val surfaceContainerLowDark = Color(0xFF151A16)
private val surfaceContainerDark = Color(0xFF1B221C)
private val surfaceContainerHighDark = Color(0xFF232A25)
private val surfaceContainerHighestDark = Color(0xFF2D352F)

// ---- Light ----
private val primaryLight = Color(0xFF059669)
private val onPrimaryLight = Color(0xFFFFFFFF)
private val primaryContainerLight = Color(0xFF9FF5CD)
private val onPrimaryContainerLight = Color(0xFF00513A)
private val secondaryLight = Color(0xFF4C635A)
private val onSecondaryLight = Color(0xFFFFFFFF)
private val secondaryContainerLight = Color(0xFFCFE9DC)
private val onSecondaryContainerLight = Color(0xFF344B42)
private val tertiaryLight = Color(0xFF3A6660)
private val onTertiaryLight = Color(0xFFFFFFFF)
private val tertiaryContainerLight = Color(0xFFBDECE4)
private val onTertiaryContainerLight = Color(0xFF214E48)
private val errorLight = Color(0xFFBA1A1A)
private val onErrorLight = Color(0xFFFFFFFF)
private val errorContainerLight = Color(0xFFFFDAD6)
private val onErrorContainerLight = Color(0xFF93000A)
private val backgroundLight = Color(0xFFF4F6F4)
private val onBackgroundLight = Color(0xFF1A1F1A)
private val surfaceLight = Color(0xFFF4F6F4)
private val onSurfaceLight = Color(0xFF1A1F1A)
private val surfaceVariantLight = Color(0xFFDBE5DD)
private val onSurfaceVariantLight = Color(0xFF404A44)
private val outlineLight = Color(0xFF707974)
private val outlineVariantLight = Color(0xFFC0C9C2)
private val scrimLight = Color(0xFF000000)
private val inverseSurfaceLight = Color(0xFF2C322E)
private val inverseOnSurfaceLight = Color(0xFFEDF2EC)
private val inversePrimaryLight = Color(0xFF34D399)
private val surfaceDimLight = Color(0xFFD5DBD5)
private val surfaceBrightLight = Color(0xFFF4F6F4)
private val surfaceContainerLowestLight = Color(0xFFFFFFFF)
private val surfaceContainerLowLight = Color(0xFFEEF3EE)
private val surfaceContainerLight = Color(0xFFE8ECE8)
private val surfaceContainerHighLight = Color(0xFFDDE3DD)
private val surfaceContainerHighestLight = Color(0xFFD7DDD7)

private val lightScheme = lightColorScheme(
    primary = primaryLight, onPrimary = onPrimaryLight,
    primaryContainer = primaryContainerLight, onPrimaryContainer = onPrimaryContainerLight,
    secondary = secondaryLight, onSecondary = onSecondaryLight,
    secondaryContainer = secondaryContainerLight, onSecondaryContainer = onSecondaryContainerLight,
    tertiary = tertiaryLight, onTertiary = onTertiaryLight,
    tertiaryContainer = tertiaryContainerLight, onTertiaryContainer = onTertiaryContainerLight,
    error = errorLight, onError = onErrorLight,
    errorContainer = errorContainerLight, onErrorContainer = onErrorContainerLight,
    background = backgroundLight, onBackground = onBackgroundLight,
    surface = surfaceLight, onSurface = onSurfaceLight,
    surfaceVariant = surfaceVariantLight, onSurfaceVariant = onSurfaceVariantLight,
    outline = outlineLight, outlineVariant = outlineVariantLight, scrim = scrimLight,
    inverseSurface = inverseSurfaceLight, inverseOnSurface = inverseOnSurfaceLight, inversePrimary = inversePrimaryLight,
    surfaceDim = surfaceDimLight, surfaceBright = surfaceBrightLight,
    surfaceContainerLowest = surfaceContainerLowestLight, surfaceContainerLow = surfaceContainerLowLight,
    surfaceContainer = surfaceContainerLight, surfaceContainerHigh = surfaceContainerHighLight,
    surfaceContainerHighest = surfaceContainerHighestLight,
)

private val darkScheme = darkColorScheme(
    primary = primaryDark, onPrimary = onPrimaryDark,
    primaryContainer = primaryContainerDark, onPrimaryContainer = onPrimaryContainerDark,
    secondary = secondaryDark, onSecondary = onSecondaryDark,
    secondaryContainer = secondaryContainerDark, onSecondaryContainer = onSecondaryContainerDark,
    tertiary = tertiaryDark, onTertiary = onTertiaryDark,
    tertiaryContainer = tertiaryContainerDark, onTertiaryContainer = onTertiaryContainerDark,
    error = errorDark, onError = onErrorDark,
    errorContainer = errorContainerDark, onErrorContainer = onErrorContainerDark,
    background = backgroundDark, onBackground = onBackgroundDark,
    surface = surfaceDark, onSurface = onSurfaceDark,
    surfaceVariant = surfaceVariantDark, onSurfaceVariant = onSurfaceVariantDark,
    outline = outlineDark, outlineVariant = outlineVariantDark, scrim = scrimDark,
    inverseSurface = inverseSurfaceDark, inverseOnSurface = inverseOnSurfaceDark, inversePrimary = inversePrimaryDark,
    surfaceDim = surfaceDimDark, surfaceBright = surfaceBrightDark,
    surfaceContainerLowest = surfaceContainerLowestDark, surfaceContainerLow = surfaceContainerLowDark,
    surfaceContainer = surfaceContainerDark, surfaceContainerHigh = surfaceContainerHighDark,
    surfaceContainerHighest = surfaceContainerHighestDark,
)

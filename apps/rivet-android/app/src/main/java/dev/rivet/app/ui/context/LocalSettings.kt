package dev.rivet.app.ui.context

import androidx.compose.runtime.staticCompositionLocalOf
import dev.rivet.app.data.datastore.Settings

val LocalSettings = staticCompositionLocalOf<Settings> {
    error("No SettingsStore provided")
}

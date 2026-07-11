package dev.rivet.app.ui.context

import androidx.compose.runtime.compositionLocalOf
import dev.rivet.app.ui.hooks.CustomTtsState

val LocalTTSState = compositionLocalOf<CustomTtsState> { error("Not provided yet") }

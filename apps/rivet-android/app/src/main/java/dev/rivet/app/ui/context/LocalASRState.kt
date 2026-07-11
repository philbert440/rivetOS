package dev.rivet.app.ui.context

import androidx.compose.runtime.compositionLocalOf
import dev.rivet.app.ui.hooks.CustomAsrState

val LocalASRState = compositionLocalOf<CustomAsrState> { error("Not provided yet") }


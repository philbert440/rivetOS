package dev.rivet.app.data.event

sealed class AppEvent {
    data class Speak(val text: String) : AppEvent()
}

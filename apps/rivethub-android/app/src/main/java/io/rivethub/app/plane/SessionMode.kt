package io.rivethub.app.plane

enum class SessionMode { Chat, Terminal }

const val MODE_CHAT = "chat"
const val MODE_TERMINAL = "terminal"

fun parseSessionMode(raw: String?): SessionMode =
    if (raw?.trim()?.lowercase() == MODE_TERMINAL) SessionMode.Terminal else SessionMode.Chat

fun persistSessionMode(mode: SessionMode): String = when (mode) {
    SessionMode.Chat -> MODE_CHAT
    SessionMode.Terminal -> MODE_TERMINAL
}

/** Prefs map key for a conversation's Chat|Terminal mode. */
fun sessionModeKey(sessionId: String): String = sessionId

/**
 * After adopt/rekey, copy the mode from the retired id onto the canonical
 * one. The canonical entry wins if both exist.
 */
fun rekeySessionModes(
    modes: Map<String, String>,
    from: String,
    to: String,
): Map<String, String> {
    if (from.isEmpty() || from == to) return modes
    val moved = modes[from] ?: return modes
    if (modes[to] != null) return modes - from
    return modes - from + (to to moved)
}

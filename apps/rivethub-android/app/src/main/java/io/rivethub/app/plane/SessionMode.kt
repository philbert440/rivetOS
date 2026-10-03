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

/**
 * Whether a view change should write [sessionModes]. Only the user's own
 * Terminal|Chat control is explicit; system Back and the terminal chrome
 * back arrow are view-only and must not overwrite an explicit choice or
 * invent a `chat` entry over a terminal-only row.
 */
fun shouldPersistSessionMode(explicit: Boolean): Boolean = explicit

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

/**
 * Settings → Conversations → Default view: which view a conversation opens
 * on when it has no explicit choice of its own. Anything but an explicit
 * `terminal` is Chat, the historical default and the web's, so an upgrade
 * leaves conversations where they were.
 */
fun parseDefaultView(raw: String?): SessionMode = parseSessionMode(raw)

/**
 * Which view a conversation opens on (web `useSessionView`). Precedence:
 * this conversation's explicit switch ([stored], written only by the user's
 * own Terminal|Chat choice) > a session that only runs in a terminal (no
 * harness to chat through) > the user's [defaultView]. New conversations and
 * older ones never switched both land on the default.
 */
fun resolveSessionMode(stored: String?, defaultView: SessionMode, terminalOnly: Boolean): SessionMode = when {
    !stored.isNullOrBlank() -> parseSessionMode(stored)
    terminalOnly -> SessionMode.Terminal
    else -> defaultView
}

/** The harness a `<harness>:<id>` session id names, when [known] lists it. */
fun harnessFromSessionId(sessionId: String, known: Collection<String>): String? {
    val i = sessionId.indexOf(':')
    if (i <= 0) return null
    return sessionId.substring(0, i).takeIf { it in known }
}

/**
 * A conversation with no harness to chat through (a legacy on-disk row whose
 * id names none) only runs in a terminal. A draft is never terminal-only: it
 * has not picked its harness yet. Unlike the web's `sessionOpensOnTerminal`
 * this does not consult the registry; it fails toward a usable view.
 */
fun opensTerminalOnly(draft: Boolean, harnessId: String?): Boolean = !draft && harnessId == null

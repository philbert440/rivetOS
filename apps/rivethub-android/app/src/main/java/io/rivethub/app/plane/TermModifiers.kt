package io.rivethub.app.plane

/** Sticky modifiers on the terminal key row. ALT has no lock. */
enum class TermMod { Ctrl, Alt }

data class TermModState(
    val ctrl: Boolean = false,
    val ctrlLocked: Boolean = false,
    val alt: Boolean = false,
)

/**
 * Tap toggles. A locked Ctrl tap clears the lock (same as the key row's
 * one-shot Ctrl). ALT only flips; nothing locks it.
 */
fun TermModState.toggle(mod: TermMod): TermModState = when (mod) {
    TermMod.Ctrl -> if (ctrlLocked) copy(ctrl = false, ctrlLocked = false) else copy(ctrl = !ctrl)
    TermMod.Alt -> copy(alt = !alt)
}

/**
 * Mods to apply to the next key, and the state afterwards.
 * Unlocked Ctrl and ALT clear; locked Ctrl stays armed.
 */
fun TermModState.consume(): Pair<TermModState, Set<TermMod>> {
    val applied = buildSet {
        if (ctrl) add(TermMod.Ctrl)
        if (alt) add(TermMod.Alt)
    }
    val next = copy(
        ctrl = ctrl && ctrlLocked,
        alt = false,
    )
    return next to applied
}

/**
 * Ctrl changes a single ASCII letter into [TermKeys.ctrl]. Anything else
 * (digits, arrows, a multi-character paste) is left as [bytes]. ALT prefixes
 * ESC. Ctrl+ALT is ESC followed by the ctrl byte.
 */
fun applyMods(bytes: ByteArray, text: String?, mods: Set<TermMod>): ByteArray {
    if (mods.isEmpty()) return bytes
    val letter = if (TermMod.Ctrl in mods) singleAsciiLetter(text, bytes) else null
    val payload = if (letter != null) TermKeys.ctrl(letter) else bytes
    return if (TermMod.Alt in mods) TermKeys.alt(payload) else payload
}

private fun singleAsciiLetter(text: String?, bytes: ByteArray): Char? {
    if (text != null) {
        if (text.length == 1 && isAsciiLetter(text[0])) return text[0]
        return null
    }
    if (bytes.size != 1) return null
    val c = (bytes[0].toInt() and 0xFF).toChar()
    return if (isAsciiLetter(c)) c else null
}

private fun isAsciiLetter(c: Char): Boolean = c in 'a'..'z' || c in 'A'..'Z'

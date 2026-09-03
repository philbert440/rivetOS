package io.rivethub.app.plane

/**
 * One accent for agent-rail dots and conversation-row stripes.
 *
 * A named preset colour wins when it is a real hex; otherwise the harness
 * palette (claude clay / grok grey / local emerald). Same inputs → same
 * colour on both surfaces. Port of `apps/rivethub-web/src/lib/agent-accent.ts`.
 */

private val HEX = Regex("^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

const val ACCENT_CLAUDE = "#CC785C"
const val ACCENT_GROK = "#9ca3af"
const val ACCENT_LOCAL = "#34d399"

fun harnessAccentHex(harnessId: String?, command: String? = null): String {
    val c = (harnessId ?: command).orEmpty().lowercase()
    if ("claude" in c) return ACCENT_CLAUDE
    if ("grok" in c) return ACCENT_GROK
    return ACCENT_LOCAL
}

fun accentFor(presetColor: String? = null, harnessId: String? = null, command: String? = null): String {
    val preset = presetColor?.trim().orEmpty()
    if (preset.isNotEmpty() && HEX.matches(preset)) return preset
    return harnessAccentHex(harnessId, command)
}

/** Drawer swatch: desktop `rosterCommandFor(harnessId) ?? agent.model`. */
fun accentForDrawer(presetColor: String?, harnessId: String?, model: String?): String =
    accentFor(presetColor, harnessId, rosterCommandFor(harnessId) ?: model)

/** Conversation-row stripe: desktop passes the session `command`. */
fun accentForConversation(presetColor: String?, harnessId: String?, command: String?): String =
    accentFor(presetColor, harnessId, command)

/** ARGB long for Compose `Color(...)` / JVM tests. Null when [hex] is not 3- or 6-digit. */
fun parseAccentArgb(hex: String): Long? {
    val h = hex.trim()
    if (!HEX.matches(h)) return null
    val body = h.drop(1)
    val rgb = if (body.length == 3) {
        body.map { "$it$it" }.joinToString("")
    } else {
        body
    }
    return 0xFF000000L or rgb.toLong(16)
}

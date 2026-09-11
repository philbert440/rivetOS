package io.rivethub.app.plane

/**
 * One accent for agent-rail dots and conversation-row stripes.
 *
 * A named preset colour wins when it is a real hex; otherwise the harness
 * palette (keyed by harness id / roster command). Same inputs → same
 * colour on both surfaces. Port of `apps/rivethub-web/src/lib/harness-colors.ts`.
 */

private val HEX = Regex("^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

const val ACCENT_CLAUDE = "#CC785C"
const val ACCENT_GROK = "#9ca3af"
const val ACCENT_CODEX = "#5b8def"
const val ACCENT_KIMI = "#8b7cf6"
const val ACCENT_HERMES = "#e0a340"
const val ACCENT_OPENCODE = "#2dd4bf"
const val ACCENT_PI = "#f472b6"
const val ACCENT_LOCAL = "#34d399"

/** String-keyed so opencode/pi compile before those ids land in HARNESS_IDS. */
private val HARNESS_ACCENTS: Map<String, String> = mapOf(
    "claude-code" to ACCENT_CLAUDE,
    "claude" to ACCENT_CLAUDE,
    "grok-build" to ACCENT_GROK,
    "grok" to ACCENT_GROK,
    "codex" to ACCENT_CODEX,
    "kimi-code" to ACCENT_KIMI,
    "kimi" to ACCENT_KIMI,
    "hermes" to ACCENT_HERMES,
    "opencode" to ACCENT_OPENCODE,
    "pi" to ACCENT_PI,
)

fun harnessAccentHex(harnessId: String?, command: String? = null): String {
    val c = (harnessId ?: command).orEmpty().lowercase()
    if (c.isEmpty()) return ACCENT_LOCAL
    HARNESS_ACCENTS[c]?.let { return it }
    val tokens = c.split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() }
    val match = HARNESS_ACCENTS.keys.sortedByDescending { it.length }.firstOrNull { it in tokens }
    return if (match != null) HARNESS_ACCENTS.getValue(match) else ACCENT_LOCAL
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

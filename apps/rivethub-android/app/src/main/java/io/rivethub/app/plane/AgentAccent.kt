package io.rivethub.app.plane

/**
 * One accent for agent-rail dots and conversation-row stripes.
 *
 * A named preset colour wins when it is a real hex; otherwise the harness
 * palette (keyed by harness id / roster command). Same inputs → same
 * colour on both surfaces. Port of `apps/rivethub-web/src/lib/harness-colors.ts`.
 */

private val HEX = Regex("^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
private val NON_ALNUM = Regex("[^a-z0-9]+")
private val WORD_BREAK = Regex("[\\s\\-_.]+")
private val LABEL_NOISE = Regex("[\\s\\-_]+")

const val ACCENT_CLAUDE = "#CC785C"
const val ACCENT_GROK = "#9ca3af"
const val ACCENT_CODEX = "#5b8def"
const val ACCENT_KIMI = "#8b7cf6"
const val ACCENT_HERMES = "#e0a340"
const val ACCENT_OPENCODE = "#2dd4bf"
const val ACCENT_PI = "#f472b6"
const val ACCENT_QWEN_CODE = "#a78bfa"
const val ACCENT_CURSOR = "#f97316"
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
    "qwen-code" to ACCENT_QWEN_CODE,
    "qwen" to ACCENT_QWEN_CODE,
    "cursor" to ACCENT_CURSOR,
)

fun harnessAccentHex(harnessId: String?, command: String? = null): String {
    val c = (harnessId ?: command).orEmpty().lowercase()
    if (c.isEmpty()) return ACCENT_LOCAL
    HARNESS_ACCENTS[c]?.let { return it }
    // Bounded match (mirrors web harness-colors.ts): a key may be one of at
    // most two delimited tokens; never a substring, never inside a longer name.
    val tokens = c.split(NON_ALNUM).filter { it.isNotEmpty() }
    if (tokens.size > 2) return ACCENT_LOCAL
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

/**
 * Tile letters for an agent: the first letter of each of the first two words
 * (`grok scout` → `GS`), else the first letter (`reviewer` → `R`). Words split
 * on whitespace, `-`, `_` and `.`; a name with no letters or digits gets `?`.
 * Port of web `agentInitials` (lib/agent-accent.ts).
 */
fun agentInitials(name: String): String {
    val words = name.split(WORD_BREAK).filter { w -> w.any { it.isLetterOrDigit() } }
    fun firstOf(w: String) = w.first { it.isLetterOrDigit() }.uppercase()
    return when (words.size) {
        0 -> "?"
        1 -> firstOf(words[0])
        else -> firstOf(words[0]) + firstOf(words[1])
    }
}

const val TILE_INK_DARK = 0xFF111111L
const val TILE_INK_LIGHT = 0xFFFFFFFFL

/**
 * Near-black or white ARGB, whichever reads better on the ARGB [fill].
 * Port of web `inkOn`: contrast is equal against #111 and #fff near L≈0.18.
 */
fun tileInkOn(fill: Long): Long {
    fun channel(shift: Int): Double {
        val v = ((fill shr shift) and 0xFF) / 255.0
        return if (v <= 0.03928) v / 12.92 else Math.pow((v + 0.055) / 1.055, 2.4)
    }
    val luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    return if (luminance > 0.18) TILE_INK_DARK else TILE_INK_LIGHT
}

/** True when two labels read the same, ignoring case, whitespace, `-` and `_`. */
fun sameLabel(a: String, b: String): Boolean {
    fun norm(v: String) = v.lowercase().replace(LABEL_NOISE, "")
    return norm(a) == norm(b)
}

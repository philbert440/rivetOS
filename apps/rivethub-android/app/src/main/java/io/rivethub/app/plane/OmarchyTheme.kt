package io.rivethub.app.plane

import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * Omarchy `colors.toml` → RivetHub app tokens. Port of
 * `apps/rivethub-web/src/lib/omarchy-theme.ts` (parseSchemaA +
 * omarchyAppTokens) so a built-in palette maps onto the same tokens here as
 * in the browser. Only schema A (Omarchy 4.x, a `mode` key) is parsed: the
 * phone has no live desktop theme to read, only [OMARCHY_PRESETS], which are
 * all schema A. Contrast floors keep ink readable when a theme's fg/bg pair
 * is too close.
 */
data class OmarchyColors(
    val mode: Mode,
    val accent: String,
    val background: String,
    val foreground: String,
    val selection: String,
    val muted: String?,
    val orange: String?,
    val bgDark: String?,
    val bgDarker: String?,
    val bgLighter: String?,
    val fgDark: String?,
    val fgLight: String?,
    val fgBright: String?,
    /** ANSI 0–15 in terminal order. */
    val ansi: List<String>,
) {
    enum class Mode { Dark, Light }
}

/** Every app color token as `#rrggbb` (web `--color-*` names in the KDoc). */
data class OmarchyTokens(
    val dark: Boolean,
    /** `--color-bg` */
    val bg: String,
    val panel: String,
    val panel2: String,
    val line: String,
    val codeBg: String,
    val ink: String,
    val inkDim: String,
    /** `--color-em` — the theme's accent. */
    val em: String,
    val emDim: String,
    val red: String,
    val warn: String,
    val link: String,
    /** `--assistant` */
    val assistant: String,
)

private val HEX6 = Regex("^#[0-9a-fA-F]{6}$")
private val HEX3 = Regex("^#[0-9a-fA-F]{3}$")
private val TOML_LINE = Regex("""^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*(#.*)?$""")

/** `#rrggbb` (lower-case) from `#rrggbb` / `#rgb` only; anything else is null. */
fun parseHexColor(raw: String?): String? {
    val v = raw?.trim() ?: return null
    if (HEX6.matches(v)) return "#" + v.substring(1).lowercase()
    if (HEX3.matches(v)) {
        val s = v.substring(1).lowercase()
        return "#" + s.map { "$it$it" }.joinToString("")
    }
    return null
}

/** Flat `key = "string"` pairs — all a colors.toml carries. */
private fun parseFlatToml(toml: String): Map<String, String> = buildMap {
    for (line in toml.lineSequence()) {
        val m = TOML_LINE.find(line) ?: continue
        put(m.groupValues[1], m.groupValues[2])
    }
}

private fun rgbOf(hex: String): IntArray? {
    val h = parseHexColor(hex) ?: return null
    return intArrayOf(
        h.substring(1, 3).toInt(16),
        h.substring(3, 5).toInt(16),
        h.substring(5, 7).toInt(16),
    )
}

fun relativeLuminance(hex: String): Double {
    val rgb = rgbOf(hex) ?: return 0.0
    fun lin(c: Int): Double {
        val s = c / 255.0
        return if (s <= 0.04045) s / 12.92 else ((s + 0.055) / 1.055).pow(2.4)
    }
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

fun contrastRatio(a: String, b: String): Double {
    val l1 = relativeLuminance(a)
    val l2 = relativeLuminance(b)
    return (maxOf(l1, l2) + 0.05) / (minOf(l1, l2) + 0.05)
}

fun mixHex(a: String, b: String, t: Double): String {
    val aa = rgbOf(a) ?: return a
    val bb = rgbOf(b) ?: return a
    val u = t.coerceIn(0.0, 1.0)
    return "#" + (0..2).joinToString("") { i ->
        // JS Math.round: half rounds up, as roundToLong does for positives.
        val v = (aa[i] * (1 - u) + bb[i] * u).roundToLong().coerceIn(0, 255)
        v.toString(16).padStart(2, '0')
    }
}

/** Parse a schema-A colors.toml, or null when a required key is missing. */
fun parseOmarchyColors(toml: String): OmarchyColors? {
    val t = parseFlatToml(toml)
    fun hex(key: String) = parseHexColor(t[key])
    val background = hex("background") ?: return null
    val foreground = hex("foreground") ?: return null
    val accent = hex("accent") ?: return null
    val red = hex("red") ?: return null
    val green = hex("green") ?: return null
    val yellow = hex("yellow") ?: return null
    val blue = hex("blue") ?: return null
    val magenta = hex("magenta") ?: return null
    val cyan = hex("cyan") ?: return null
    val mode = when (t["mode"]) {
        "dark" -> OmarchyColors.Mode.Dark
        "light" -> OmarchyColors.Mode.Light
        else -> if (relativeLuminance(background) > 0.5) OmarchyColors.Mode.Light else OmarchyColors.Mode.Dark
    }
    val darkBg = hex("dark_background")
    val darkerBg = hex("darker_background")
    val lightFg = hex("light_foreground")
    val darkFg = hex("dark_foreground")
    val brightFg = hex("bright_foreground")
    val muted = hex("muted")
    val ansi = listOf(
        darkerBg ?: darkBg ?: background,
        red, green, yellow, blue, magenta, cyan,
        lightFg ?: foreground,
        muted ?: darkFg ?: foreground,
        hex("bright_red") ?: red,
        hex("bright_green") ?: green,
        hex("bright_yellow") ?: yellow,
        hex("bright_blue") ?: blue,
        hex("bright_magenta") ?: magenta,
        hex("bright_cyan") ?: cyan,
        brightFg ?: foreground,
    )
    return OmarchyColors(
        mode = mode,
        accent = accent,
        background = background,
        foreground = foreground,
        selection = hex("selection") ?: background,
        muted = muted,
        orange = hex("orange"),
        bgDark = darkBg,
        bgDarker = darkerBg,
        bgLighter = hex("lighter_background"),
        fgDark = darkFg,
        fgLight = lightFg,
        fgBright = brightFg,
        ansi = ansi,
    )
}

private fun lift(bg: String, mode: OmarchyColors.Mode, t: Double, fg: String): String =
    mixHex(bg, if (mode == OmarchyColors.Mode.Light) "#ffffff" else fg, t)

private fun nudgeContrast(color: String, bg: String, min: Double, toward: String, maxSteps: Int = 25): String {
    var c = color
    repeat(maxSteps) {
        if (contrastRatio(c, bg) >= min) return c
        c = mixHex(c, toward, 0.1)
    }
    return if (contrastRatio(c, bg) >= min) c else toward
}

private fun pickWarn(c: OmarchyColors): String {
    val candidates = listOf(c.orange, c.ansi[3], c.ansi[11], "#f59e0b", "#b45309")
    for (cand in candidates) {
        if (cand != null && contrastRatio(cand, c.background) >= 3.0) return cand
    }
    // Never red / bright_red / accent — the last candidate is the light-theme warn.
    return "#b45309"
}

private data class BgVariants(val lighter: String, val darker: String, val hasDarker: Boolean)

private fun pickBgVariants(c: OmarchyColors): BgVariants {
    val bgL = relativeLuminance(c.background)
    var lighter: String? = null
    var darker: String? = null
    for (v in listOfNotNull(c.bgDark, c.bgDarker, c.bgLighter)) {
        val l = relativeLuminance(v)
        if (l > bgL) {
            if (lighter == null || l > relativeLuminance(lighter)) lighter = v
        } else if (l < bgL) {
            if (darker == null || l < relativeLuminance(darker)) darker = v
        }
    }
    return BgVariants(
        lighter = lighter ?: lift(c.background, c.mode, 0.06, c.foreground),
        darker = darker ?: mixHex(
            c.background,
            if (c.mode == OmarchyColors.Mode.Light) c.foreground else "#000000",
            0.12,
        ),
        hasDarker = darker != null,
    )
}

fun omarchyAppTokens(c: OmarchyColors): OmarchyTokens {
    val (lighter, darker, hasDarker) = pickBgVariants(c)
    val bg = c.background
    val fg = c.foreground
    val light = c.mode == OmarchyColors.Mode.Light
    val panel = if (light) lift(bg, c.mode, 0.6, fg) else mixHex(bg, lighter, 0.35)
    val panel2 = if (light) (if (hasDarker) darker else mixHex(bg, fg, 0.08)) else lighter
    val inkToward = if (light) "#000000" else "#ffffff"
    val ink = nudgeContrast(fg, bg, 4.5, inkToward)
    var inkDim = c.fgDark ?: mixHex(fg, bg, 0.45)
    inkDim = nudgeContrast(inkDim, bg, 3.0, fg)
    if (contrastRatio(inkDim, bg) < 3.0) inkDim = nudgeContrast(inkDim, bg, 3.0, inkToward)
    return OmarchyTokens(
        dark = !light,
        bg = bg,
        panel = panel,
        panel2 = panel2,
        line = mixHex(panel2, fg, 0.15),
        codeBg = panel,
        ink = ink,
        inkDim = inkDim,
        em = c.accent,
        emDim = mixHex(c.accent, bg, 0.25),
        red = c.ansi[1],
        warn = pickWarn(c),
        link = c.ansi[4],
        assistant = c.fgLight ?: fg,
    )
}

/** Tokens for a preset id, or null for an unknown id. */
fun omarchyPresetTokens(id: String): OmarchyTokens? =
    OMARCHY_PRESETS.firstOrNull { it.id == id }?.let { parseOmarchyColors(it.toml) }?.let(::omarchyAppTokens)

/** `#rrggbb` → opaque ARGB long (0xFFrrggbb). */
fun hexToArgb(hex: String): Long = 0xFF000000L or (parseHexColor(hex) ?: "#000000").substring(1).toLong(16)

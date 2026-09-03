package io.rivethub.app.data

import java.util.Base64

/**
 * OSC 10/11/12 color-query filter — twin of rivethub-web `lib/osc-filter.ts`.
 *
 * Harnesses emit OSC 11? on startup; a real xterm answers with the theme
 * background via stdin, which then shows up as garbage `]11;rgb:…` in the TUI.
 * Strip queries from PTY output and never forward a report as keystrokes.
 */
object OscFilter {
    fun stripQueries(data: ByteArray): ByteArray {
        if (data.isEmpty()) return data
        val s = String(data, Charsets.ISO_8859_1)
        val cleaned = OSC_COLOR_QUERY.replace(s, "")
        if (cleaned.length == s.length) return data
        return cleaned.toByteArray(Charsets.ISO_8859_1)
    }

    fun isColorReport(data: String): Boolean = OSC_COLOR_REPORT.containsMatchIn(data)

    // ESC ] (10|11|12) ; ?  BEL   or   ESC ] … ST (ESC \)
    private val OSC_COLOR_QUERY = Regex("\u001b\\](?:10|11|12);\\?(?:\u0007|\u001b\\\\)")
    private val OSC_COLOR_REPORT = Regex("(?:\u001b)?\\](?:10|11|12);rgb:", RegexOption.IGNORE_CASE)
}

/**
 * OSC 52 clipboard writes — twin of rivethub-web `decodeOsc52Write`.
 * Reads (`?`), empty, oversized, and malformed payloads are ignored so a
 * PTY cannot leak the clipboard or flood it.
 */
object Osc52 {
    const val MAX_B64 = 256 * 1024

    /**
     * [data] is the OSC 52 payload after the `52;` command (`<sel>;<b64>`).
     * Returns the decoded write, or null to ignore.
     */
    fun decodeWrite(data: String): String? {
        val sep = data.indexOf(';')
        if (sep == -1) return null
        val payload = data.substring(sep + 1).replace(WHITESPACE, "")
        if (payload.isEmpty() || payload == "?" || payload.length > MAX_B64) return null
        return try {
            String(Base64.getDecoder().decode(payload), Charsets.UTF_8)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private val WHITESPACE = Regex("\\s+")
}

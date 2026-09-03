package io.rivethub.app.data


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

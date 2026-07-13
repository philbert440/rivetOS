package dev.rivet.app.ui.pages.terminal

/**
 * Port of web `apps/rivethub-web/src/lib/osc-filter.ts`.
 *
 * Harnesses emit OSC 11? on startup; terminals answer with `rgb:…` reports that
 * leak into the remote PTY as fake keystrokes (`]11;rgb:0d0d/1111/1717`). Strip
 * color *queries* on the server→client path and drop color *reports* on the
 * client→server path.
 */
internal object OscFilter {
    // ESC ] (10|11|12) ; ? (BEL | ST)
    private val OSC_COLOR_QUERY =
        Regex("\u001b\\](?:10|11|12);\\?(?:\u0007|\u001b\\\\)")

    // optional ESC + ] (10|11|12) ; rgb:
    private val OSC_COLOR_REPORT =
        Regex("(?:\u001b)?\\](?:10|11|12);rgb:", RegexOption.IGNORE_CASE)

    /**
     * Strip OSC 10/11/12 color queries from PTY→client bytes so attach/scrollback
     * replay does not generate rgb: replies.
     *
     * Byte-oriented like the web helper (one Latin-1 char per byte) so multi-byte
     * UTF-8 payload is left intact except for exact OSC matches.
     */
    fun stripOscColorQueries(data: ByteArray, offset: Int = 0, length: Int = data.size): ByteArray {
        if (length <= 0) return data
        val end = (offset + length).coerceAtMost(data.size)
        val start = offset.coerceAtLeast(0)
        if (start >= end) return ByteArray(0)
        // Fast path: no ESC in chunk → nothing to strip.
        var hasEsc = false
        for (i in start until end) {
            if (data[i] == 0x1b.toByte()) {
                hasEsc = true
                break
            }
        }
        if (!hasEsc) {
            return if (start == 0 && end == data.size) data else data.copyOfRange(start, end)
        }
        val s = buildString(end - start) {
            for (i in start until end) append((data[i].toInt() and 0xff).toChar())
        }
        val cleaned = OSC_COLOR_QUERY.replace(s, "")
        if (cleaned.length == s.length) {
            return if (start == 0 && end == data.size) data else data.copyOfRange(start, end)
        }
        return ByteArray(cleaned.length) { i -> cleaned[i].code.and(0xff).toByte() }
    }

    /** True if data looks like an xterm-generated OSC color report (fg/bg/cursor). */
    fun isOscColorReport(data: ByteArray, offset: Int = 0, length: Int = data.size): Boolean {
        if (length <= 0) return false
        val end = (offset + length).coerceAtMost(data.size)
        val start = offset.coerceAtLeast(0)
        if (start >= end) return false
        val s = buildString(end - start) {
            for (i in start until end) append((data[i].toInt() and 0xff).toChar())
        }
        return OSC_COLOR_REPORT.containsMatchIn(s)
    }
}

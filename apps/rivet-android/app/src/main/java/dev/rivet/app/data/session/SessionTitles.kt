package dev.rivet.app.data.session

/**
 * Derived conversation titles for gateway / den sessions.
 *
 * Matches RivetHub web: a new session is titled from the first user message
 * (trimmed, whitespace-collapsed, length-capped). Empty input yields an empty
 * string so callers can keep a placeholder.
 */
object SessionTitles {
    const val DEFAULT_MAX_LEN = 80

    fun fromFirstUserMessage(text: String, maxLen: Int = DEFAULT_MAX_LEN): String {
        val collapsed = text.trim().replace(WHITESPACE, " ")
        if (collapsed.isEmpty() || maxLen <= 0) return ""
        if (collapsed.length <= maxLen) return collapsed
        // Prefer a word boundary when the cut is mid-string.
        val hard = collapsed.take(maxLen)
        val sp = hard.lastIndexOf(' ')
        return if (sp >= maxLen / 2) hard.substring(0, sp).trimEnd() else hard.trimEnd()
    }

    private val WHITESPACE = Regex("\\s+")
}

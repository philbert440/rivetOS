package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn

// Match offsets are relative to snippet; matchEnd is exclusive.
data class SearchHit(val turnIndex: Int, val snippet: String, val matchStart: Int, val matchEnd: Int)

fun searchTurns(
    turns: List<HarnessTranscriptTurn>,
    query: String,
    snippetChars: Int = 90,
): List<SearchHit> {
    val needle = query.trim()
    if (needle.isEmpty()) return emptyList()
    return turns.mapIndexedNotNull { index, turn ->
        val match = turn.text.indexOf(needle, ignoreCase = true)
        if (match < 0) return@mapIndexedNotNull null
        // Keep the entire match even when the query exceeds the snippet budget.
        val budget = snippetChars.coerceAtLeast(needle.length)
        val leading = minOf(12, match, budget - needle.length)
        val start = match - leading
        val end = (start.toLong() + budget).coerceAtMost(turn.text.length.toLong()).toInt()
        val prefix = if (start > 0) "…" else ""
        val snippet = prefix + turn.text.substring(start, end) + if (end < turn.text.length) "…" else ""
        val matchStart = prefix.length + leading
        SearchHit(index, snippet, matchStart, matchStart + needle.length)
    }
}

fun highlightRanges(hit: SearchHit): IntRange = hit.matchStart until hit.matchEnd

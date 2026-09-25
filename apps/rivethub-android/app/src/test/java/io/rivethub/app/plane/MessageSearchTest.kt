package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageSearchTest {
    private fun turn(text: String, thinking: String? = null) =
        HarnessTranscriptTurn(role = "assistant", text = text, thinking = thinking)

    @Test fun `search ignores case and trims query preserving turn indices`() {
        val hits = searchTurns(listOf(turn("none"), turn("Hello WORLD"), turn("world again")), "  WoRlD  ")
        assertEquals(listOf(1, 2), hits.map { it.turnIndex })
        assertEquals("WORLD", hits[0].snippet.substring(hits[0].matchStart, hits[0].matchEnd))
        assertEquals(6..10, highlightRanges(hits[0]))
    }

    @Test fun `snippet cuts both ends with twelve leading characters`() {
        val text = "a".repeat(30) + "MATCH" + "z".repeat(120)
        val hit = searchTurns(listOf(turn(text)), "match").single()
        assertEquals("…" + "a".repeat(12) + "MATCH" + "z".repeat(73) + "…", hit.snippet)
        assertEquals(13, hit.matchStart)
        assertEquals(18, hit.matchEnd)
        assertEquals("MATCH", hit.snippet.slice(highlightRanges(hit)))
    }

    @Test fun `short text and edge matches omit unneeded ellipses`() {
        assertEquals(SearchHit(0, "hit end", 0, 3), searchTurns(listOf(turn("hit end")), "hit").single())
        assertEquals("…" + "a".repeat(12) + "hit", searchTurns(listOf(turn("a".repeat(30) + "hit")), "hit").single().snippet)
        assertEquals("hit a…", searchTurns(listOf(turn("hit abcdef")), "hit", 5).single().snippet)
    }

    @Test fun `only first match per turn and thinking is not searched`() {
        val hits = searchTurns(listOf(turn("hit HIT hit"), turn("none", thinking = "hit")), "hit")
        assertEquals(listOf(SearchHit(0, "hit HIT hit", 0, 3)), hits)
    }

    @Test fun `empty whitespace missing query and empty turns have no hits`() {
        for (query in listOf("", " \n\t", "absent")) {
            assertTrue(searchTurns(listOf(turn("hello")), query).isEmpty())
        }
        assertTrue(searchTurns(emptyList(), "hello").isEmpty())
    }

    @Test fun `tiny snippet budgets retain the entire match`() {
        for (budget in listOf(-1, 0, 3)) {
            val hit = searchTurns(listOf(turn("before needle after")), "needle", budget).single()
            assertEquals("…needle…", hit.snippet)
            assertEquals("needle", hit.snippet.slice(highlightRanges(hit)))
        }
    }
}

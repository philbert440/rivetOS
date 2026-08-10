package dev.rivet.app.data.session

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionTitlesTest {
    @Test
    fun trimsAndCollapsesWhitespace() {
        assertEquals(
            "ship the release",
            SessionTitles.fromFirstUserMessage("  ship   the\nrelease  "),
        )
    }

    @Test
    fun emptyStaysEmpty() {
        assertEquals("", SessionTitles.fromFirstUserMessage("   \n\t  "))
        assertEquals("", SessionTitles.fromFirstUserMessage(""))
    }

    @Test
    fun capsAtMaxLenOnWordBoundary() {
        val long = "one two three four five six seven eight nine ten eleven twelve"
        val title = SessionTitles.fromFirstUserMessage(long, maxLen = 20)
        assertEquals("one two three four", title)
        assertTrue(title.length <= 20)
    }

    @Test
    fun hardCutWhenNoWordBoundary() {
        val title = SessionTitles.fromFirstUserMessage("abcdefghijklmnopqrstuvwxyz", maxLen = 10)
        assertEquals("abcdefghij", title)
    }

    private fun assertTrue(condition: Boolean) {
        org.junit.Assert.assertTrue(condition)
    }
}

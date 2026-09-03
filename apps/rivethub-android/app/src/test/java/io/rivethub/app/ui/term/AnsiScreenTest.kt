package io.rivethub.app.ui.term

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AnsiScreenTest {
    @Test
    fun `CSI question 1 h sets application cursor`() {
        val s = AnsiScreen(80, 24)
        assertFalse(s.applicationCursor)
        s.feed("\u001b[?1h".toByteArray(Charsets.ISO_8859_1))
        assertTrue(s.applicationCursor)
    }

    @Test
    fun `CSI question 1 l clears application cursor`() {
        val s = AnsiScreen(80, 24)
        s.feed("\u001b[?1h".toByteArray(Charsets.ISO_8859_1))
        s.feed("\u001b[?1l".toByteArray(Charsets.ISO_8859_1))
        assertFalse(s.applicationCursor)
    }

    @Test
    fun `reset clears application cursor`() {
        val s = AnsiScreen(80, 24)
        s.feed("\u001b[?1h".toByteArray(Charsets.ISO_8859_1))
        s.reset()
        assertFalse(s.applicationCursor)
    }

    @Test
    fun `snapshot returns the requested row count`() {
        val s = AnsiScreen(40, 10)
        val lines = s.snapshot(0, 10)
        assertEquals(10, lines.size)
    }
}

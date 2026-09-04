package io.rivethub.app.ui.term

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Golden feed → snapshot cases for the TUI CSI set. Each assertion is on
 * cell contents or cursor after a sequence, so dropping the op fails the test.
 */
class AnsiParserTest {
    @Test
    fun `DECSTBM IND at region bottom scrolls only the region`() {
        val s = AnsiScreen(20, 5)
        s.fillRows("ABCDE")
        s.feedStr("\u001b[2;4r")
        s.feedStr("\u001b[4;1H")
        s.feedStr("\u001bD")
        assertEquals("A".repeat(20), s.cells(0))
        assertEquals("C".repeat(20), s.cells(1))
        assertEquals("D".repeat(20), s.cells(2))
        assertEquals(" ".repeat(20), s.cells(3))
        assertEquals("E".repeat(20), s.cells(4))
        assertEquals(5, s.lineCount)
    }

    @Test
    fun `full-screen IND archives the top line into scrollback`() {
        val s = AnsiScreen(20, 5)
        s.fillRows("ABCDE")
        s.feedStr("\u001b[5;1H")
        s.feedStr("\u001bD")
        assertEquals(6, s.lineCount)
        assertEquals("A".repeat(20), s.snapshot(0, 1).single().spans.joinToString("") { it.text })
        assertEquals("B".repeat(20), s.cells(0))
        assertEquals(" ".repeat(20), s.cells(4))
    }

    @Test
    fun `ICH inserts blanks at cursor and drops cells past the right margin`() {
        val s = AnsiScreen(20, 5)
        s.feedStr("01234567890123456789")
        s.feedStr("\u001b[1;3H")
        s.feedStr("\u001b[2@")
        assertEquals("01  2345678901234567", s.cells(0))
        assertEquals(0 to 2, s.cursorCell())
    }

    @Test
    fun `DCH deletes at cursor and blank-fills the right margin`() {
        val s = AnsiScreen(20, 5)
        s.feedStr("01234567890123456789")
        s.feedStr("\u001b[1;3H")
        s.feedStr("\u001b[2P")
        assertEquals("014567890123456789  ", s.cells(0))
        assertEquals(0 to 2, s.cursorCell())
    }

    @Test
    fun `ECH erases n cells without shifting or moving the cursor`() {
        val s = AnsiScreen(20, 5)
        s.feedStr("01234567890123456789")
        s.feedStr("\u001b[1;3H")
        s.feedStr("\u001b[2X")
        assertEquals("01  4567890123456789", s.cells(0))
        assertEquals(0 to 2, s.cursorCell())
    }

    @Test
    fun `IL inserts blank lines within the scroll region`() {
        val s = AnsiScreen(20, 5)
        s.fillRows("ABCDE")
        s.feedStr("\u001b[2;4r")
        s.feedStr("\u001b[3;5H") // row 3, col 5 — IL must home the cursor to col 0
        s.feedStr("\u001b[1L")
        assertEquals("A".repeat(20), s.cells(0))
        assertEquals("B".repeat(20), s.cells(1))
        assertEquals(" ".repeat(20), s.cells(2))
        assertEquals("C".repeat(20), s.cells(3))
        assertEquals("E".repeat(20), s.cells(4))
        assertEquals(2 to 0, s.cursorCell())
    }

    @Test
    fun `DL deletes lines within the scroll region`() {
        val s = AnsiScreen(20, 5)
        s.fillRows("ABCDE")
        s.feedStr("\u001b[2;4r")
        s.feedStr("\u001b[3;5H") // row 3, col 5 — DL must home the cursor to col 0
        s.feedStr("\u001b[1M")
        assertEquals("A".repeat(20), s.cells(0))
        assertEquals("B".repeat(20), s.cells(1))
        assertEquals("D".repeat(20), s.cells(2))
        assertEquals(" ".repeat(20), s.cells(3))
        assertEquals("E".repeat(20), s.cells(4))
        assertEquals(2 to 0, s.cursorCell())
    }

    @Test
    fun `SU scrolls the region up and blanks vacated lines`() {
        val s = AnsiScreen(20, 5)
        s.fillRows("ABCDE")
        s.feedStr("\u001b[2;4r")
        s.feedStr("\u001b[1S")
        assertEquals("A".repeat(20), s.cells(0))
        assertEquals("C".repeat(20), s.cells(1))
        assertEquals("D".repeat(20), s.cells(2))
        assertEquals(" ".repeat(20), s.cells(3))
        assertEquals("E".repeat(20), s.cells(4))
    }

    @Test
    fun `SD scrolls the region down and blanks vacated lines`() {
        val s = AnsiScreen(20, 5)
        s.fillRows("ABCDE")
        s.feedStr("\u001b[2;4r")
        s.feedStr("\u001b[1T")
        assertEquals("A".repeat(20), s.cells(0))
        assertEquals(" ".repeat(20), s.cells(1))
        assertEquals("B".repeat(20), s.cells(2))
        assertEquals("C".repeat(20), s.cells(3))
        assertEquals("E".repeat(20), s.cells(4))
    }

    @Test
    fun `DECAWM last-column write plus next char wraps once`() {
        val s = AnsiScreen(20, 5)
        s.feedStr("\u001b[?7h")
        s.feedStr("01234567890123456789")
        assertEquals(0 to 19, s.cursorCell())
        s.feedStr("X")
        assertEquals("01234567890123456789", s.cells(0))
        assertTrue(s.cells(1).startsWith("X"))
        assertEquals(" ".repeat(20), s.cells(2))
        assertEquals(1 to 1, s.cursorCell())
    }

    @Test
    fun `DECAWM off clamps writes at the last column`() {
        val s = AnsiScreen(20, 5)
        s.feedStr("\u001b[?7l")
        s.feedStr("01234567890123456789")
        s.feedStr("Z")
        assertEquals("0123456789012345678Z", s.cells(0))
        assertEquals(0 to 19, s.cursorCell())
        assertEquals(" ".repeat(20), s.cells(1))
    }

    @Test
    fun `DECSET 1049 enter is a cleared alt buffer and exit restores primary`() {
        val s = AnsiScreen(20, 5)
        s.feedStr("HELLO")
        s.feedStr("\u001b[?1049h")
        assertEquals(" ".repeat(20), s.cells(0))
        assertEquals(5, s.lineCount)
        s.feedStr("ALT")
        assertTrue(s.cells(0).startsWith("ALT"))
        s.feedStr("\u001b[5;1H")
        repeat(4) { s.feedStr("\u001bD") }
        assertEquals(5, s.lineCount)
        s.feedStr("\u001b[?1049l")
        assertTrue(s.cells(0).startsWith("HELLO"))
        assertEquals(5, s.lineCount)
        val all = (0 until s.lineCount).joinToString("") { i ->
            s.snapshot(i, 1).single().spans.joinToString("") { it.text }
        }
        assertTrue(!all.contains("ALT"))
        s.feedStr("\u001b[?47h")
        assertEquals(" ".repeat(20), s.cells(0))
        s.feedStr("\u001b[?1047l")
        assertTrue(s.cells(0).startsWith("HELLO"))
    }

    @Test
    fun `HT advances to the next 8-column tab stop`() {
        val s = AnsiScreen(20, 5)
        s.feedStr("A\tB")
        assertEquals('A', s.cells(0)[0])
        assertEquals('B', s.cells(0)[8])
        assertEquals(0 to 9, s.cursorCell())
    }

    @Test
    fun `LF CR BS stay correct inside a scroll region`() {
        val s = AnsiScreen(20, 5)
        s.fillRows("ABCDE")
        s.feedStr("\u001b[2;4r")
        s.feedStr("\u001b[3;1H")
        s.feedStr("XY\rZ")
        assertTrue(s.cells(2).startsWith("ZY"))
        s.feedStr("\u001b[3;1H")
        s.feedStr("AB\u0008C")
        assertTrue(s.cells(2).startsWith("AC"))
        s.feedStr("\u001b[4;1H")
        s.feedStr("\n")
        assertEquals("A".repeat(20), s.cells(0))
        assertTrue(s.cells(1).startsWith("AC"))
        assertEquals("D".repeat(20), s.cells(2))
        assertEquals(" ".repeat(20), s.cells(3))
        assertEquals("E".repeat(20), s.cells(4))
    }

    @Test
    fun `decstbm clamps bottom to rows and rejects an inverted region`() {
        assertEquals(1..3, TermRegion.decstbm(2, 4, 5))
        assertEquals(0..4, TermRegion.decstbm(0, 0, 5))
        assertEquals(0..4, TermRegion.decstbm(1, 99, 5))
        assertNull(TermRegion.decstbm(3, 3, 5))
        assertNull(TermRegion.decstbm(5, 2, 5))
    }

    @Test
    fun `count treats zero as one and caps at room`() {
        assertEquals(1, TermRegion.count(0, 5))
        assertEquals(3, TermRegion.count(3, 5))
        assertEquals(5, TermRegion.count(9, 5))
        assertEquals(0, TermRegion.count(2, 0))
        assertNotEquals(9, TermRegion.count(9, 5))
    }
}

private fun AnsiScreen.feedStr(s: String) = feed(s.toByteArray(Charsets.ISO_8859_1))

private fun AnsiScreen.cells(row: Int): String {
    val first = lineCount - rows
    return snapshot(first + row, 1).single().spans.joinToString("") { it.text }
}

private fun AnsiScreen.cursorCell(): Pair<Int, Int> {
    val first = lineCount - rows
    snapshot(first, rows).forEachIndexed { r, line ->
        for (span in line.spans) {
            if (span.bg == AnsiScreen.CURSOR) return r to span.startCol
        }
    }
    error("cursor not visible in snapshot")
}

private fun AnsiScreen.fillRows(chars: String) {
    chars.forEachIndexed { i, ch ->
        feedStr("\u001b[${i + 1};1H" + ch.toString().repeat(cols))
    }
}

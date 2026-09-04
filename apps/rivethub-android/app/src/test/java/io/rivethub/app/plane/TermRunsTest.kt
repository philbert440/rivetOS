package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TermRunsTest {
    @Test
    fun `attribute change splits a run`() {
        val cells = listOf(
            TermRunCell('a', fg = 1, bg = 0, bold = false),
            TermRunCell('b', fg = 1, bg = 0, bold = false),
            TermRunCell('c', fg = 1, bg = 0, bold = true),
            TermRunCell('d', fg = 1, bg = 0, bold = true),
        )
        val runs = rowRuns(cells)
        assertEquals(2, runs.size)
        assertEquals("ab", runs[0].text)
        assertEquals("cd", runs[1].text)
        assertFalse(runs[0].bold)
        assertTrue(runs[1].bold)
    }

    @Test
    fun `run startCol is the cell index not a pixel`() {
        val cells = List(10) { TermRunCell('x', fg = 1, bg = 0) } +
            TermRunCell('y', fg = 2, bg = 0)
        val runs = rowRuns(cells)
        assertEquals(2, runs.size)
        assertEquals(0, runs[0].startCol)
        assertEquals(10, runs[1].startCol)
        assertEquals("y", runs[1].text)
        assertEquals(runs[0].startCol + runs[0].text.length, runs[1].startCol)
    }

    @Test
    fun `cursor cell yields its own run`() {
        val cursorFg = 0xFF0D1117.toInt()
        val cursorBg = 0xFF34D399.toInt()
        val cells = listOf(
            TermRunCell('p', fg = 1, bg = 0),
            TermRunCell('r', fg = 1, bg = 0),
            TermRunCell('$', fg = cursorFg, bg = cursorBg),
            TermRunCell(' ', fg = 1, bg = 0),
        )
        val runs = rowRuns(cells)
        assertEquals(3, runs.size)
        assertEquals(2, runs[1].startCol)
        assertEquals("$", runs[1].text)
        assertEquals(cursorFg, runs[1].fg)
        assertEquals(cursorBg, runs[1].bg)
        assertEquals(1, runs[1].text.length)
    }
}

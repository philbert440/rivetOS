package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TermScrollTest {
    @Test
    fun `finger down (drag toward older) leaves tail`() {
        val s = TermScroll(lineCount = 100, rows = 24)
        assertTrue(s.followTail)
        assertEquals(76, s.visibleFirst(100, 24))
        s.dragBy(20f, 10f)
        assertFalse(s.followTail)
        assertEquals(74, s.visibleFirst(100, 24))
        assertEquals(74, s.firstLine)
    }

    @Test
    fun `finger up back to the bottom re-follows`() {
        val s = TermScroll(lineCount = 100, rows = 24)
        s.dragBy(40f, 10f)
        assertFalse(s.followTail)
        s.dragBy(-80f, 10f)
        assertTrue(s.followTail)
        assertEquals(76, s.visibleFirst(100, 24))
    }

    @Test
    fun `append while detached does not move the view`() {
        val s = TermScroll(lineCount = 100, rows = 24)
        s.dragBy(50f, 10f)
        val frozen = s.visibleFirst(s.lineCount, s.rows)
        assertEquals(71, frozen)
        s.onLinesAppended(5, 0)
        assertFalse(s.followTail)
        assertEquals(frozen, s.visibleFirst(s.lineCount, s.rows))
        assertEquals(105, s.lineCount)
    }

    @Test
    fun `head-drop compensation keeps the visible lines`() {
        val s = TermScroll(lineCount = 100, rows = 24)
        s.dragBy(50f, 10f)
        val before = s.firstLine
        assertEquals(71, before)
        s.onLinesAppended(1, 1)
        assertEquals(before - 1, s.firstLine)
        assertEquals(before - 1, s.visibleFirst(s.lineCount, s.rows))
        assertEquals(100, s.lineCount)
    }

    @Test
    fun `resize clamp`() {
        val s = TermScroll(lineCount = 200, rows = 24)
        s.dragBy(500f, 10f)
        assertFalse(s.followTail)
        assertEquals(126, s.firstLine)
        s.onResize(40, 24)
        assertEquals(16, s.visibleFirst(40, 24))
        assertTrue(s.followTail)
        assertEquals(16, s.firstLine)
    }

    @Test
    fun `sub-cell drag from the tail keeps following and moves nothing`() {
        val s = TermScroll(lineCount = 100, rows = 24)
        s.dragBy(5f, 10f)
        assertTrue(s.followTail)
        assertEquals(76, s.visibleFirst(100, 24))
        s.onLinesAppended(3, 0)
        assertTrue(s.followTail)
        assertEquals(79, s.visibleFirst(s.lineCount, s.rows))
    }

    @Test
    fun `sub-cell drags accumulate across events into whole lines`() {
        val s = TermScroll(lineCount = 100, rows = 24)
        s.dragBy(6f, 10f)
        assertTrue(s.followTail)
        s.dragBy(6f, 10f)
        assertFalse(s.followTail)
        assertEquals(75, s.firstLine)
        s.dragBy(-4f, 10f)
        assertFalse(s.followTail)
        s.dragBy(-8f, 10f)
        assertTrue(s.followTail)
        assertEquals(76, s.visibleFirst(100, 24))
    }
}

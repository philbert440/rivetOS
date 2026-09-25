package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageJumperTest {
    @Test
    fun `empty list has nowhere to go`() {
        assertEquals(JumpTargets(0, null, null, 0), jumpTargets(0, 0, 0))
    }

    @Test
    fun `prev and next step between user turns around the window top`() {
        // users at 0, 2, 5, 8; list of 11 (turns + live + spacer)
        val t = jumpTargets(firstVisible = 4, lastVisible = 6, count = 11, stops = listOf(0, 2, 5, 8))
        assertEquals(0, t.top)
        assertEquals(2, t.prev)
        assertEquals(5, t.next)
        assertEquals(10, t.bottom)
    }

    @Test
    fun `a user turn at the top is not its own previous`() {
        val t = jumpTargets(firstVisible = 5, lastVisible = 7, count = 11, stops = listOf(0, 2, 5, 8))
        assertEquals(2, t.prev)
        assertEquals(8, t.next)
    }

    @Test
    fun `at the top there is no previous`() {
        val t = jumpTargets(firstVisible = 0, lastVisible = 3, count = 11, stops = listOf(0, 2, 5, 8))
        assertNull(t.prev)
        assertEquals(2, t.next)
    }

    @Test
    fun `showing the last item drops next`() {
        val t = jumpTargets(firstVisible = 6, lastVisible = 10, count = 11, stops = listOf(0, 2, 5, 8))
        assertEquals(5, t.prev)
        assertNull(t.next)
    }

    @Test
    fun `default stops are every item and out of range stops are ignored`() {
        val t = jumpTargets(firstVisible = 3, lastVisible = 4, count = 6)
        assertEquals(2, t.prev)
        assertEquals(4, t.next)
        val u = jumpTargets(firstVisible = 3, lastVisible = 4, count = 6, stops = listOf(-1, 9, 1))
        assertEquals(1, u.prev)
        assertNull(u.next)
    }

    @Test
    fun `visible for three seconds after the scroll goes idle`() {
        assertFalse(jumperVisible(userScrolled = false, idleMs = 1_000, now = 1_000))
        assertTrue(jumperVisible(userScrolled = true, idleMs = 1_000, now = 1_000))
        assertTrue(jumperVisible(userScrolled = true, idleMs = 1_000, now = 3_999))
        assertFalse(jumperVisible(userScrolled = true, idleMs = 1_000, now = 4_000))
        assertFalse(jumperVisible(userScrolled = true, idleMs = 5_000, now = 4_000))
    }

    @Test
    fun `hide delay counts down and clamps`() {
        assertEquals(JUMPER_VISIBLE_MS, jumperHideDelayMs(idleMs = 1_000, now = 1_000))
        assertEquals(1_000L, jumperHideDelayMs(idleMs = 1_000, now = 3_000))
        assertEquals(0L, jumperHideDelayMs(idleMs = 1_000, now = 9_000))
        assertEquals(JUMPER_VISIBLE_MS, jumperHideDelayMs(idleMs = 9_000, now = 1_000))
    }
}

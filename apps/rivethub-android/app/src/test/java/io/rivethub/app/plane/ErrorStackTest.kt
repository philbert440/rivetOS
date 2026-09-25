package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorStackTest {
    @Test fun `push appends newest at the bottom`() {
        var list = emptyList<ChatError>()
        list = pushError(list, "a", null, id = 1)
        list = pushError(list, "b", "x", id = 2)
        assertEquals(listOf(1L, 2L), list.map { it.id })
        assertEquals(ChatError(2, "b", "x"), list.last())
    }

    @Test fun `push caps the stack and drops the oldest`() {
        var list = emptyList<ChatError>()
        for (i in 1..7) list = pushError(list, "e$i", null, id = i.toLong())
        assertEquals(ERROR_STACK_MAX, list.size)
        assertEquals(listOf(3L, 4L, 5L, 6L, 7L), list.map { it.id })
        val two = pushError(pushError(pushError(emptyList(), "a", null, 1, max = 2), "b", null, 2, max = 2), "c", null, 3, max = 2)
        assertEquals(listOf("b", "c"), two.map { it.text })
    }

    @Test fun `dismiss removes only that id`() {
        val list = listOf(ChatError(1, "a"), ChatError(2, "b"), ChatError(3, "c"))
        assertEquals(listOf(1L, 3L), dismissError(list, 2).map { it.id })
        assertEquals(list, dismissError(list, 99))
    }

    @Test fun `clear empties the stack and clear-all shows only above one card`() {
        val list = listOf(ChatError(1, "a"), ChatError(2, "b"))
        assertTrue(clearErrors(list).isEmpty())
        assertTrue(showClearAll(list))
        assertFalse(showClearAll(list.take(1)))
        assertFalse(showClearAll(emptyList()))
    }

    @Test fun `composer and attachment codes stay on the strip`() {
        for (code in listOf("uploading", "too_large", "failed_attachment", "image_only", "image_unsupported")) {
            assertTrue(code, isStripError(code))
        }
        assertFalse(isStripError(null))
        assertFalse(isStripError("idle_timeout"))
        assertFalse(isStripError("network"))
    }

    @Test fun `repeated publishes of one terminal error stack one card`() {
        var gate = RepeatErrorGate()
        var list = emptyList<ChatError>()
        var id = 0L
        repeat(4) {
            val (g, stack) = gate.admit("s1", "connection refused")
            gate = g
            if (stack) list = pushError(list, "connection refused", null, id = ++id)
        }
        assertEquals(listOf("connection refused"), list.map { it.text })
    }

    @Test fun `a dismissed terminal card is not re-added by a republish`() {
        var gate = RepeatErrorGate()
        val (g1, first) = gate.admit("s1", "boom")
        gate = g1
        assertTrue(first)
        var list = pushError(emptyList(), "boom", null, id = 1)
        list = dismissError(list, 1)
        // retry clears the error, then fails the same way again
        val (g2, cleared) = gate.admit("s1", null)
        gate = g2
        assertFalse(cleared)
        val (g3, again) = gate.admit("s1", "boom")
        gate = g3
        assertFalse(again)
        assertTrue(list.isEmpty())
    }

    @Test fun `a later distinct terminal failure stacks a new card`() {
        val (g1, a) = RepeatErrorGate().admit("s1", "boom")
        val (g2, b) = g1.admit("s1", "session was not adopted")
        assertTrue(a)
        assertTrue(b)
        assertEquals(setOf("boom", "session was not adopted"), g2.seen)
        // blank never stacks; a new session starts over
        assertFalse(g2.admit("s1", " ").second)
        assertTrue(g2.admit("s2", "boom").second)
    }
}

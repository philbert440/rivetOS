package io.rivethub.app.plane

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TermModifiersTest {
    @Test
    fun `arm then consume clears unlocked ctrl and alt`() {
        val armed = TermModState().toggle(TermMod.Ctrl).toggle(TermMod.Alt)
        assertTrue(armed.ctrl)
        assertTrue(armed.alt)
        assertFalse(armed.ctrlLocked)
        val (next, applied) = armed.consume()
        assertEquals(setOf(TermMod.Ctrl, TermMod.Alt), applied)
        assertEquals(TermModState(), next)
        val (again, none) = next.consume()
        assertEquals(emptySet<TermMod>(), none)
        assertEquals(TermModState(), again)
    }

    @Test
    fun `locked ctrl survives consume and a later alt`() {
        val locked = TermModState(ctrl = true, ctrlLocked = true).toggle(TermMod.Alt)
        val (next, applied) = locked.consume()
        assertEquals(setOf(TermMod.Ctrl, TermMod.Alt), applied)
        assertEquals(TermModState(ctrl = true, ctrlLocked = true, alt = false), next)
        val (still, ctrlOnly) = next.consume()
        assertEquals(setOf(TermMod.Ctrl), ctrlOnly)
        assertEquals(next, still)
    }

    @Test
    fun `toggling locked ctrl clears the lock`() {
        val cleared = TermModState(ctrl = true, ctrlLocked = true).toggle(TermMod.Ctrl)
        assertEquals(TermModState(), cleared)
    }

    @Test
    fun `alt prefixes ESC and does not stick after consume`() {
        val (next, applied) = TermModState(alt = true).consume()
        assertEquals(setOf(TermMod.Alt), applied)
        assertFalse(next.alt)
        assertArrayEquals(
            byteArrayOf(0x1b, 'b'.code.toByte()),
            applyMods("b".toByteArray(), "b", applied),
        )
    }

    @Test
    fun `ctrl plus alt is ESC then the ctrl byte`() {
        val out = applyMods(
            "c".toByteArray(),
            "c",
            setOf(TermMod.Ctrl, TermMod.Alt),
        )
        assertArrayEquals(byteArrayOf(0x1b, 0x03), out)
        assertArrayEquals(
            byteArrayOf(0x1b, 0x03),
            applyMods("C".toByteArray(), "C", setOf(TermMod.Ctrl, TermMod.Alt)),
        )
    }

    @Test
    fun `ctrl on a single letter is the control byte`() {
        assertArrayEquals(
            byteArrayOf(0x03),
            applyMods("c".toByteArray(), "c", setOf(TermMod.Ctrl)),
        )
        assertArrayEquals(
            byteArrayOf(0x01),
            applyMods(byteArrayOf('a'.code.toByte()), null, setOf(TermMod.Ctrl)),
        )
    }

    @Test
    fun `non letter with ctrl passes through`() {
        val digit = "1".toByteArray()
        assertArrayEquals(digit, applyMods(digit, "1", setOf(TermMod.Ctrl)))
        val arrow = TermKeys.UP
        assertArrayEquals(arrow, applyMods(arrow, null, setOf(TermMod.Ctrl)))
        val word = "cd".toByteArray()
        assertArrayEquals(word, applyMods(word, "cd", setOf(TermMod.Ctrl)))
        val accent = "é".toByteArray(Charsets.UTF_8)
        assertArrayEquals(accent, applyMods(accent, "é", setOf(TermMod.Ctrl)))
    }

    @Test
    fun `alt still prefixes a non letter`() {
        assertArrayEquals(
            byteArrayOf(0x1b, '1'.code.toByte()),
            applyMods("1".toByteArray(), "1", setOf(TermMod.Ctrl, TermMod.Alt)),
        )
    }

    @Test
    fun `no mods leaves bytes untouched`() {
        val raw = "c".toByteArray()
        assertArrayEquals(raw, applyMods(raw, "c", emptySet()))
    }
}

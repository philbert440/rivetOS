package io.rivethub.app.plane

import io.rivethub.app.gateway.TermFrame
import io.rivethub.app.gateway.parseTermFrame
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TermPtyTest {
    @Test
    fun `mux tmux skips the ring replay frame`() {
        val g = TermReplayGate()
        g.onHello("tmux")
        assertTrue(g.skipRing)
        assertFalse(g.acceptBinary())
        assertTrue(g.acceptBinary())
    }

    @Test
    fun `mux none replays the ring`() {
        val g = TermReplayGate()
        g.onHello("none")
        assertFalse(g.skipRing)
        assertTrue(g.acceptBinary())
        assertTrue(g.acceptBinary())
    }

    @Test
    fun `absent mux replays the ring`() {
        val g = TermReplayGate()
        g.onHello(null)
        assertFalse(skipRingReplay(null))
        assertTrue(g.acceptBinary())
    }

    @Test
    fun `binary before hello is dropped`() {
        val g = TermReplayGate()
        assertEquals(TermReplayGate.Phase.Hello, g.phase)
        assertFalse(g.acceptBinary())
    }

    @Test
    fun `live binary after skipped ring is fed`() {
        val g = TermReplayGate()
        g.onHello("TMUX")
        assertTrue(skipRingReplay("TMUX"))
        assertFalse(g.acceptBinary())
        assertEquals(TermReplayGate.Phase.Live, g.phase)
        assertTrue(g.acceptBinary())
        assertTrue(g.acceptBinary())
    }

    @Test
    fun `hello json carries mux`() {
        val tmux = parseTermFrame(
            """{"type":"hello","v":1,"id":"p1","denSession":"s","command":"claude","cols":80,"rows":24,"state":"running","mux":"tmux"}""",
        ) as TermFrame.Hello
        assertEquals("tmux", tmux.frame.mux)
        assertTrue(skipRingReplay(tmux.frame.mux))
        val none = parseTermFrame(
            """{"type":"hello","v":1,"id":"p1","cols":80,"rows":24,"state":"running"}""",
        ) as TermFrame.Hello
        assertNull(none.frame.mux)
        assertFalse(skipRingReplay(none.frame.mux))
    }

    @Test
    fun `resize uses pane size and font metrics`() {
        val (cw, ch) = termCellSizePx(13f, 2f)
        assertEquals(13f * 2f * TERM_MONO_ASPECT, cw, 0.01f)
        assertEquals(13f * 2f * TERM_LINE_HEIGHT, ch, 0.01f)
        val geo = termColsRows(800f, 480f, 10f, 20f)
        assertNotNull(geo)
        assertEquals(80, geo!!.first)
        assertEquals(24, geo.second)
    }

    @Test
    fun `resize clamps to server limits`() {
        val hi = termColsRows(100_000f, 100_000f, 1f, 1f)!!
        assertEquals(TERM_MAX_COLS, hi.first)
        assertEquals(TERM_MAX_ROWS, hi.second)
        val lo = termColsRows(10f, 10f, 8f, 16f)!!
        assertEquals(TERM_MIN_COLS, lo.first)
        assertEquals(TERM_MIN_ROWS, lo.second)
    }

    @Test
    fun `resize skipped on empty pane`() {
        assertNull(termColsRows(0f, 400f, 8f, 16f))
        assertNull(termColsRows(400f, 0f, 8f, 16f))
        assertNull(termColsRows(400f, 400f, 0f, 16f))
    }

    @Test
    fun `Enter is CR`() {
        assertArrayEquals(byteArrayOf(0x0d), TermKeys.ENTER)
    }

    @Test
    fun `Backspace is DEL`() {
        assertArrayEquals(byteArrayOf(0x7f), TermKeys.BACKSPACE)
    }

    @Test
    fun `Ctrl letter is a control byte`() {
        assertArrayEquals(byteArrayOf(0x03), TermKeys.ctrl('c'))
        assertArrayEquals(byteArrayOf(0x03), TermKeys.ctrl('C'))
        assertArrayEquals(byteArrayOf(0x01), TermKeys.ctrl('a'))
    }

    @Test
    fun `arrows are CSI`() {
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x41), TermKeys.UP)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x42), TermKeys.DOWN)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x43), TermKeys.RIGHT)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x44), TermKeys.LEFT)
    }

    @Test
    fun `Esc and Tab`() {
        assertArrayEquals(byteArrayOf(0x1b), TermKeys.ESC)
        assertArrayEquals(byteArrayOf(0x09), TermKeys.TAB)
    }

    @Test
    fun `IME text is UTF-8`() {
        assertArrayEquals("héllo".toByteArray(Charsets.UTF_8), TermKeys.utf8("héllo"))
        assertArrayEquals(byteArrayOf(0x03, 0x04), TermKeys.ime("cd", ctrl = true))
        assertArrayEquals("ab".toByteArray(Charsets.UTF_8), TermKeys.ime("ab", ctrl = false))
    }

    @Test
    fun `attach command renders the ssh tmux line`() {
        val cmd = renderAttachCommand("rivet-abcd", "claude:sess", "192.0.2.10", "rivet")
        assertEquals("ssh rivet@192.0.2.10 -t tmux -L rivet-abcd attach -t claude:sess", cmd)
    }

    @Test
    fun `attach command is absent without a descriptor`() {
        assertNull(renderAttachCommand(null, "s", "192.0.2.10", "rivet"))
        assertNull(renderAttachCommand("sock", null, "192.0.2.10", "rivet"))
        assertNull(renderAttachCommand("sock", "s", "", "rivet"))
        assertNull(renderAttachCommand("sock", "s", "192.0.2.10", "  "))
    }

    @Test
    fun `leave sends detach and never kill`() {
        val sink = RecordingTermSink()
        val client = TermPtyClient(sink)
        client.resize(80, 24)
        client.sendKeys(TermKeys.ENTER)
        client.leave()
        assertEquals(listOf("""{"type":"resize","cols":80,"rows":24}""", TERM_DETACH_JSON), sink.texts)
        assertEquals(1, sink.binaries.size)
        assertTrue(sink.closed)
        assertTrue(sink.texts.none { it.contains("kill") })
        assertFalse(TERM_DETACH_JSON.contains("kill"))
    }

    @Test
    fun `resize frame is JSON cols rows`() {
        assertEquals("""{"type":"resize","cols":120,"rows":36}""", termResizeJson(120, 36))
    }
}

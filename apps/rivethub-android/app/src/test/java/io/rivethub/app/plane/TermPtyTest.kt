package io.rivethub.app.plane

import io.rivethub.app.gateway.TermAttachInfo
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
    fun `mux tmux writes the ring replay frame`() {
        val g = TermReplayGate()
        g.onHello()
        assertTrue(g.acceptBinary())
        assertTrue(g.acceptBinary())
    }

    @Test
    fun `mux none writes the ring`() {
        val g = TermReplayGate()
        g.onHello()
        assertEquals(TermReplayGate.Phase.Live, g.phase)
        assertTrue(g.acceptBinary())
        assertTrue(g.acceptBinary())
    }

    @Test
    fun `absent mux writes the ring`() {
        val g = TermReplayGate()
        g.onHello()
        assertTrue(g.acceptBinary())
    }

    @Test
    fun `binary before hello is dropped`() {
        val g = TermReplayGate()
        assertEquals(TermReplayGate.Phase.Hello, g.phase)
        assertFalse(g.acceptBinary())
    }

    @Test
    fun `live binary after the ring is fed`() {
        val g = TermReplayGate()
        g.onHello()
        assertTrue(g.acceptBinary())
        assertEquals(TermReplayGate.Phase.Live, g.phase)
        assertTrue(g.acceptBinary())
        assertTrue(g.acceptBinary())
    }

    @Test
    fun `hello json carries mux and still writes the ring`() {
        val tmux = parseTermFrame(
            """{"type":"hello","v":1,"id":"p1","denSession":"s","command":"claude","cols":80,"rows":24,"state":"running","mux":"tmux"}""",
        ) as TermFrame.Hello
        assertEquals("tmux", tmux.frame.mux)
        val g = TermReplayGate()
        g.onHello()
        assertTrue(g.acceptBinary())
        val none = parseTermFrame(
            """{"type":"hello","v":1,"id":"p1","cols":80,"rows":24,"state":"running"}""",
        ) as TermFrame.Hello
        assertNull(none.frame.mux)
        g.reset()
        g.onHello()
        assertTrue(g.acceptBinary())
    }

    @Test
    fun `fontScale enlarges the fallback cell`() {
        val (w1, h1) = termCellSizePx(13f, 2f, 1f)
        val (w2, h2) = termCellSizePx(13f, 2f, 1.3f)
        assertEquals(w1 * 1.3f, w2, 0.01f)
        assertEquals(h1 * 1.3f, h2, 0.01f)
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
    fun `arrows are SS3 when application cursor is on`() {
        assertArrayEquals(byteArrayOf(0x1b, 0x4f, 0x41), TermKeys.up(true))
        assertArrayEquals(byteArrayOf(0x1b, 0x4f, 0x42), TermKeys.down(true))
        assertArrayEquals(byteArrayOf(0x1b, 0x4f, 0x43), TermKeys.right(true))
        assertArrayEquals(byteArrayOf(0x1b, 0x4f, 0x44), TermKeys.left(true))
    }

    @Test
    fun `Esc and Tab`() {
        assertArrayEquals(byteArrayOf(0x1b), TermKeys.ESC)
        assertArrayEquals(byteArrayOf(0x09), TermKeys.TAB)
    }

    @Test
    fun `IME text is UTF-8`() {
        assertArrayEquals("héllo".toByteArray(Charsets.UTF_8), TermKeys.utf8("héllo"))
        assertArrayEquals("ab".toByteArray(Charsets.UTF_8), TermKeys.ime("ab", ctrl = false))
    }

    @Test
    fun `IME ctrl applies to the first ASCII char only`() {
        assertArrayEquals(
            byteArrayOf(0x03) + "d".toByteArray(Charsets.UTF_8),
            TermKeys.ime("cd", ctrl = true),
        )
    }

    @Test
    fun `IME ctrl is ignored for non-ASCII`() {
        assertArrayEquals("é".toByteArray(Charsets.UTF_8), TermKeys.ime("é", ctrl = true))
    }

    @Test
    fun `latched ctrl then two keystrokes is one control then literal`() {
        val first = TermKeys.ime("c", ctrl = true)
        val second = TermKeys.ime("l", ctrl = false)
        assertArrayEquals(byteArrayOf(0x03), first)
        assertArrayEquals(byteArrayOf('l'.code.toByte()), second)
    }

    @Test
    fun `attach command renders the ssh tmux line`() {
        val cmd = renderAttachCommand(
            TermAttachInfo("rivet-abcd", "claude:sess", "192.0.2.10", "rivet", local = false),
        )
        assertEquals("ssh rivet@192.0.2.10 -t tmux -L rivet-abcd attach -t claude:sess", cmd)
    }

    @Test
    fun `attach command is absent without a descriptor`() {
        assertNull(renderAttachCommand(null))
        assertNull(renderAttachCommand(TermAttachInfo("", "s", "192.0.2.10", "rivet")))
        assertNull(renderAttachCommand(TermAttachInfo("sock", "s", "", "rivet")))
        assertNull(renderAttachCommand(TermAttachInfo("sock", "s", "192.0.2.10", "  ")))
    }

    @Test
    fun `attach command local skips ssh`() {
        val cmd = renderAttachCommand(
            TermAttachInfo("rivet-abcd", "claude:sess", "192.0.2.10", "rivet", local = true),
        )
        assertEquals("tmux -L rivet-abcd attach -t claude:sess", cmd)
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
    }

    @Test
    fun `resize frame is JSON cols rows`() {
        assertEquals("""{"type":"resize","cols":120,"rows":36}""", termResizeJson(120, 36))
    }
}

class RecordingTermSink : TermSink {
    val texts = ArrayList<String>()
    val binaries = ArrayList<ByteArray>()
    var closed: Boolean = false
        private set

    override fun sendText(text: String): Boolean {
        texts += text
        return true
    }

    override fun sendBinary(bytes: ByteArray): Boolean {
        binaries += bytes
        return true
    }

    override fun close() {
        closed = true
    }

    @Test fun `imeDelta is append-only, strips the sentinel, and folds newlines to CR`() {
        val z = "\u200B"
        assertEquals("o", imeDelta(z + "N", z + "No", z))
        assertEquals("", imeDelta(z + "No", z + "N", z))          // shrink → no backspaces
        assertEquals("w", imeDelta(z + "No", z + "Nw", z))        // replacement → only the new tail
        assertEquals("abc", imeDelta(z, z + "abc", z))            // paste
        assertEquals("abc", imeDelta(z, "abc", z))                // sentinel gone → tail still sent once
        assertEquals("\r", imeDelta(z, z + "\n", z))              // soft Enter
        assertEquals("a\rb\r", imeDelta(z, z + "a\r\nb\n", z))     // CRLF collapses
        assertEquals("", imeDelta(z + "x", z + "x" + z, z))       // a re-inserted sentinel is never sent
    }
}

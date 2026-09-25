package io.rivethub.app.plane

import io.rivethub.app.gateway.TermSpawnResponse
import io.rivethub.app.gateway.WsStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TermAttachControllerTest {
    @Test
    fun `hello mux tmux writes the ring`() {
        withHarness { h ->
            h.ctl.ensure()
            h.socket.pushStatus(WsStatus.OPEN)
            h.socket.pushText(hello(mux = "tmux"))
            h.socket.pushBinary("screen".toByteArray())
            assertEquals(1, h.screen.fed.size)
            assertArrayEquals("screen".toByteArray(), h.screen.fed.single())
        }
    }

    @Test
    fun `reconnect resets then writes`() {
        withHarness { h ->
            h.ctl.ensure()
            h.socket.pushStatus(WsStatus.OPEN)
            h.socket.pushText(hello())
            h.socket.pushBinary("one".toByteArray())
            val resetsAfterFirst = h.screen.resets
            h.socket.pushStatus(WsStatus.CLOSED)
            h.socket.pushStatus(WsStatus.CONNECTING)
            h.socket.pushStatus(WsStatus.OPEN)
            h.socket.pushText(hello())
            h.socket.pushBinary("two".toByteArray())
            assertTrue(h.screen.resets > resetsAfterFirst)
            assertArrayEquals("two".toByteArray(), h.screen.fed.last())
        }
    }

    @Test
    fun `leave sends exactly detach and closes`() {
        withHarness { h ->
            h.ctl.ensure()
            h.ctl.userDetach()
            assertEquals(listOf(TERM_DETACH_JSON), h.socket.texts)
            assertTrue(h.socket.closed)
            assertTrue(h.socket.texts.none { it.contains("kill") })
        }
    }

    @Test
    fun `background then foreground reattaches`() {
        withHarness { h ->
            h.ctl.ensure()
            assertEquals(1, h.watches)
            h.ctl.onBackground()
            assertTrue(h.socket.closed)
            h.ctl.onForeground()
            assertEquals(2, h.watches)
        }
    }

    @Test
    fun `generation bump drops the attach and sends nothing further`() {
        withHarness { h ->
            h.ctl.ensure()
            h.gen = 99
            h.ctl.ensure()
            assertTrue(h.socket.closed)
            h.socket.binaries.clear()
            h.ctl.sendText("a")
            assertTrue(h.socket.binaries.isEmpty())
        }
    }

    @Test
    fun `draft attaches only after adoption`() {
        var draft = true
        var adopted = false
        withHarness(
            isDraft = { draft },
            spawnAndAdopt = { adopted = true; draft = false },
        ) { h ->
            h.ctl.ensure()
            assertTrue(adopted)
            assertEquals(1, h.spawns)
            assertEquals(1, h.watches)
        }
    }

    @Test
    fun `draft that is not adopted does not watch`() {
        withHarness(
            isDraft = { true },
            spawnAndAdopt = { },
        ) { h ->
            h.ctl.ensure()
            assertEquals(0, h.spawns)
            assertEquals(0, h.watches)
            assertEquals(TermStatus.Closed, h.views.last().status)
        }
    }

    @Test
    fun `latched ctrl then two keystrokes is one control then literal`() {
        withHarness { h ->
            h.ctl.ensure()
            h.ctl.toggleCtrl()
            assertTrue(h.views.last().ctrl)
            h.ctl.sendText("c")
            h.ctl.sendText("l")
            assertEquals(2, h.socket.binaries.size)
            assertArrayEquals(byteArrayOf(0x03), h.socket.binaries[0])
            assertArrayEquals(byteArrayOf('l'.code.toByte()), h.socket.binaries[1])
            assertTrue(!h.views.last().ctrl)
        }
    }

    @Test
    fun `alt armed replace-edit sends raw dels then one esc prefix`() {
        withHarness { h ->
            h.ctl.ensure()
            h.ctl.toggleAlt()
            h.ctl.sendBytesRaw(TermKeys.backspaces(3))
            h.ctl.sendBytes(TermKeys.ime("cat", ctrl = false))
            assertEquals(2, h.socket.binaries.size)
            assertArrayEquals(byteArrayOf(0x7f, 0x7f, 0x7f), h.socket.binaries[0])
            assertArrayEquals(
                byteArrayOf(0x1b, 'c'.code.toByte(), 'a'.code.toByte(), 't'.code.toByte()),
                h.socket.binaries[1],
            )
            assertFalse(h.views.last().alt)
        }
    }

    @Test
    fun `alt armed pure delete still prefixes esc`() {
        withHarness { h ->
            h.ctl.ensure()
            h.ctl.toggleAlt()
            h.ctl.sendBytes(TermKeys.backspaces(2))
            assertArrayEquals(byteArrayOf(0x1b, 0x7f, 0x7f), h.socket.binaries.single())
            assertFalse(h.views.last().alt)
        }
    }

    @Test
    fun `latched alt is consumed once as an ESC prefix`() {
        withHarness { h ->
            h.ctl.ensure()
            h.ctl.toggleAlt()
            assertTrue(h.views.last().alt)
            h.ctl.sendText("b")
            h.ctl.sendBytes(byteArrayOf('x'.code.toByte()))
            assertEquals(2, h.socket.binaries.size)
            assertArrayEquals(byteArrayOf(0x1b, 'b'.code.toByte()), h.socket.binaries[0])
            assertArrayEquals(byteArrayOf('x'.code.toByte()), h.socket.binaries[1])
            assertFalse(h.views.last().alt)
        }
    }

    @Test
    fun `ctrl and alt together send ESC then the ctrl byte`() {
        withHarness { h ->
            h.ctl.ensure()
            h.ctl.toggleCtrl()
            h.ctl.toggleAlt()
            h.ctl.sendText("c")
            assertArrayEquals(byteArrayOf(0x1b, 0x03), h.socket.binaries.single())
            assertFalse(h.views.last().ctrl)
            assertFalse(h.views.last().alt)
            assertFalse(h.views.last().ctrlLocked)
        }
    }

    @Test
    fun `restart after an exited pty watches a replacement id`() {
        val cache = PtyAttachCache()
        withHarness(ptyCache = cache) { h ->
            h.ctl.ensure()
            h.socket.pushText(
                """{"type":"hello","v":1,"id":"pty-1","denSession":"s","command":"claude","cols":80,"rows":24,"state":"exited"}""",
            )
            assertEquals(TermStatus.Exited, h.views.last().status)
            assertEquals(listOf("pty-1"), h.watched)
            val first = h.socket
            restartSessionPty(cache) { h.ctl.restart() }
            assertTrue(first.closed)
            // Attach sends resize after hello; restart must end on detach and never kill.
            assertEquals(TERM_DETACH_JSON, first.texts.lastOrNull())
            assertTrue(first.texts.none { it.contains("kill") })
            assertEquals(listOf("pty-1", "pty-2"), h.watched)
            assertEquals(2, h.spawns)
            assertFalse(h.socket.closed)
        }
    }

    @Test
    fun `restart drops then ensures`() {
        withHarness { h ->
            h.ctl.ensure()
            val first = h.socket
            assertEquals(1, h.watches)
            assertEquals(1, h.spawns)
            h.ctl.restart()
            assertTrue(first.closed)
            assertEquals(listOf(TERM_DETACH_JSON), first.texts)
            assertTrue(first.texts.none { it.contains("kill") })
            assertEquals(2, h.watches)
            assertEquals(2, h.spawns)
            assertFalse(h.socket.closed)
        }
    }

    private fun hello(mux: String? = "tmux"): String {
        val muxJson = if (mux != null) ""","mux":"$mux"""" else ""
        return """{"type":"hello","v":1,"id":"p1","denSession":"s","command":"claude","cols":80,"rows":24,"state":"running"$muxJson}"""
    }

    private fun withHarness(
        isDraft: () -> Boolean = { false },
        spawnAndAdopt: suspend () -> Unit = {},
        ptyCache: PtyAttachCache? = null,
        body: (Harness) -> Unit,
    ) {
        val job = SupervisorJob()
        val scope = CoroutineScope(job + Dispatchers.Unconfined)
        val h = Harness(scope, isDraft, spawnAndAdopt, ptyCache)
        try {
            body(h)
        } finally {
            h.ctl.close()
            scope.cancel()
        }
    }

    private class FakeScreen : TermScreenPort {
        var resets = 0
        val fed = ArrayList<ByteArray>()
        private var gen = 0
        override fun reset(cols: Int, rows: Int) { resets++; gen++ }
        override fun resize(cols: Int, rows: Int) { gen++ }
        override fun feed(bytes: ByteArray) { fed += bytes.copyOf(); gen++ }
        override fun drainOsc52(): List<String> = emptyList()
        override val generation get() = gen
    }

    private class FakeSocket : TermSocket {
        val texts = ArrayList<String>()
        val binaries = ArrayList<ByteArray>()
        var closed = false
        override var reconnectOnClose = true
        var onText: ((String) -> Unit)? = null
        var onBinary: ((ByteArray) -> Unit)? = null
        var onStatus: ((WsStatus) -> Unit)? = null
        override fun sendText(text: String): Boolean { texts += text; return true }
        override fun sendBinary(bytes: ByteArray): Boolean { binaries += bytes.copyOf(); return true }
        override fun close() { closed = true }
        fun pushText(text: String) { onText?.invoke(text) }
        fun pushBinary(bytes: ByteArray) { onBinary?.invoke(bytes) }
        fun pushStatus(s: WsStatus) { onStatus?.invoke(s) }
    }

    private class Harness(
        scope: CoroutineScope,
        isDraft: () -> Boolean,
        spawnAndAdopt: suspend () -> Unit,
        ptyCache: PtyAttachCache?,
    ) {
        val screen = FakeScreen()
        val views = ArrayList<TermAttachView>()
        var gen = 1
        var spawns = 0
        var watches = 0
        var freshIds = 0
        val watched = ArrayList<String>()
        var socket = FakeSocket()
        val ctl = TermAttachController(
            scope = scope,
            spawn = TermSpawnPort { _, _, _, _, _, _ ->
                spawns++
                val id = if (ptyCache == null) {
                    "pty-1"
                } else {
                    ptyCache.cached() ?: "pty-${++freshIds}".also { ptyCache.remember(it) }
                }
                TermSpawnResponse(id = id)
            },
            watch = TermWatchFactory { ptyId, onText, onBinary, onStatus ->
                watches++
                watched += ptyId
                socket = FakeSocket()
                socket.onText = onText
                socket.onBinary = onBinary
                socket.onStatus = onStatus
                socket
            },
            screen = screen,
            attachedGen = 1,
            currentGen = { gen },
            sessionId = { "sess" },
            isDraft = isDraft,
            spawnAndAdopt = spawnAndAdopt,
            command = { "claude" },
            flags = { SpawnFlags() },
            onPublish = { views += it },
            coalesceMs = 0,
        )
    }
}

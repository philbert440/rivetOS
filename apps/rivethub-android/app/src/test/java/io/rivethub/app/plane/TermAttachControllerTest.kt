package io.rivethub.app.plane

import io.rivethub.app.gateway.TermSpawnResponse
import io.rivethub.app.gateway.WsStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
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

    private fun hello(mux: String? = "tmux"): String {
        val muxJson = if (mux != null) ""","mux":"$mux"""" else ""
        return """{"type":"hello","v":1,"id":"p1","denSession":"s","command":"claude","cols":80,"rows":24,"state":"running"$muxJson}"""
    }

    private fun withHarness(
        isDraft: () -> Boolean = { false },
        spawnAndAdopt: suspend () -> Unit = {},
        body: (Harness) -> Unit,
    ) {
        val job = SupervisorJob()
        val scope = CoroutineScope(job + Dispatchers.Unconfined)
        val h = Harness(scope, isDraft, spawnAndAdopt)
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
    ) {
        val screen = FakeScreen()
        val views = ArrayList<TermAttachView>()
        var gen = 1
        var spawns = 0
        var watches = 0
        var socket = FakeSocket()
        val ctl = TermAttachController(
            scope = scope,
            spawn = TermSpawnPort { _, _, _, _, _, _ ->
                spawns++
                TermSpawnResponse(id = "pty-1")
            },
            watch = TermWatchFactory { _, onText, onBinary, onStatus ->
                watches++
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

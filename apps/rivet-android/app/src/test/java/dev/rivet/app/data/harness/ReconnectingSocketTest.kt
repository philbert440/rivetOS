package dev.rivet.app.data.harness

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reconnect behavior, including the thing a browser client never has to think
 * about: a phone flaps networks constantly, so a handshake the node will always
 * refuse must not become a permanent background retry loop.
 */
class ReconnectingSocketTest {

    private class FakeWebSocket : WebSocket {
        var cancelled = false
        var closedWith: Int? = null
        override fun cancel() {
            cancelled = true
        }

        override fun close(code: Int, reason: String?): Boolean {
            closedWith = code
            return true
        }

        override fun queueSize(): Long = 0
        override fun request(): Request = Request.Builder().url("http://node.invalid/").build()
        override fun send(text: String): Boolean = true
        override fun send(bytes: ByteString): Boolean = true
    }

    private class Transport {
        val sockets = mutableListOf<FakeWebSocket>()
        val listeners = mutableListOf<WebSocketListener>()
        val urls = mutableListOf<String>()

        fun connect(url: String, listener: WebSocketListener): WebSocket {
            urls.add(url)
            listeners.add(listener)
            return FakeWebSocket().also { sockets.add(it) }
        }

        val current: WebSocketListener get() = listeners.last()
        val currentSocket: FakeWebSocket get() = sockets.last()
    }

    private class Recorder : HarnessStreamListener {
        var opens = 0
        var closes = 0
        val events = mutableListOf<HarnessEvent>()
        val terminals = mutableListOf<String>()

        override fun onOpen() {
            opens++
        }

        override fun onEvent(event: HarnessEvent) {
            events.add(event)
        }

        override fun onClosed() {
            closes++
        }

        override fun onTerminal(message: String) {
            terminals.add(message)
        }
    }

    /** Records scheduled reconnects instead of firing them. */
    private class Timer {
        val delays = mutableListOf<Long>()
        var task: (() -> Unit)? = null
        var cancels = 0

        fun schedule(delayMs: Long, task: () -> Unit): HarnessCancellable {
            delays.add(delayMs)
            this.task = task
            return HarnessCancellable { cancels++ }
        }

        fun fire() {
            val next = task
            task = null
            next?.invoke()
        }
    }

    private fun response(code: Int): Response = Response.Builder()
        .request(Request.Builder().url("http://node.invalid/api/harness-sessions/ws").build())
        .protocol(Protocol.HTTP_1_1)
        .code(code)
        .message("fake $code")
        .build()

    private fun socket(
        transport: Transport,
        listener: Recorder,
        timer: Timer,
        url: String = "ws://node.invalid/api/harness-sessions/ws?session=abc",
    ) = ReconnectingSocket(
        url = { url },
        listener = listener,
        connectSocket = transport::connect,
        scheduleReconnect = timer::schedule,
    ).start()

    @Test
    fun `open and frames reach the listener`() {
        val transport = Transport()
        val sink = Recorder()
        socket(transport, sink, Timer())

        transport.current.onOpen(transport.currentSocket, response(101))
        transport.current.onMessage(
            transport.currentSocket,
            """{"type":"assistant-delta","sessionId":"claude-code:a","text":"hi"}""",
        )

        assertEquals(1, sink.opens)
        assertEquals(1, sink.events.size)
    }

    @Test
    fun `an unparseable frame does not kill the subscription`() {
        val transport = Transport()
        val sink = Recorder()
        socket(transport, sink, Timer())
        transport.current.onOpen(transport.currentSocket, response(101))

        transport.current.onMessage(transport.currentSocket, "ping")
        transport.current.onMessage(
            transport.currentSocket,
            """{"type":"turn-complete","sessionId":"claude-code:a"}""",
        )

        assertEquals(1, sink.events.size)
        assertTrue(sink.terminals.isEmpty())
    }

    @Test
    fun `a dropped connection reconnects on a doubling backoff`() {
        val transport = Transport()
        val sink = Recorder()
        val timer = Timer()
        socket(transport, sink, timer)

        transport.current.onOpen(transport.currentSocket, response(101))
        transport.current.onClosed(transport.currentSocket, 1006, "gone")
        timer.fire()
        transport.current.onFailure(transport.currentSocket, RuntimeException("radio"), null)

        assertEquals(2, transport.urls.size) // exactly one reconnect happened
        assertEquals(2, sink.closes)
        assertTrue(sink.terminals.isEmpty())
        // 500ms then 1000ms, before jitter.
        assertTrue(timer.delays[0] >= 500L && timer.delays[0] < 750L)
        assertTrue(timer.delays[1] >= 1_000L && timer.delays[1] < 1_250L)
    }

    @Test
    fun `a successful open resets the backoff`() {
        val transport = Transport()
        val sink = Recorder()
        val timer = Timer()
        socket(transport, sink, timer)

        transport.current.onOpen(transport.currentSocket, response(101))
        transport.current.onClosed(transport.currentSocket, 1006, "gone")
        timer.fire()
        transport.current.onOpen(transport.currentSocket, response(101))
        transport.current.onClosed(transport.currentSocket, 1006, "gone again")

        assertEquals(2, timer.delays.size)
        // Back to the base delay, not 1s — the second connect succeeded.
        assertTrue(timer.delays[1] < 750L)
    }

    @Test
    fun `a 401 handshake is terminal - no reconnect, reported once`() {
        val transport = Transport()
        val sink = Recorder()
        val timer = Timer()
        socket(transport, sink, timer)

        transport.current.onFailure(
            transport.currentSocket,
            RuntimeException("Expected HTTP 101"),
            response(401),
        )

        assertEquals(1, sink.terminals.size)
        assertTrue(sink.terminals.single().contains("401"))
        assertTrue(sink.terminals.single().contains("not authorized"))
        // The whole point: nothing is scheduled, so a radio flap cannot re-ask.
        assertTrue(timer.delays.isEmpty())
        assertNull(timer.task)
        assertEquals(1, transport.urls.size)
        // Terminal is not a plain close — the listener must not treat it as one.
        assertEquals(0, sink.closes)
    }

    @Test
    fun `403 and 404 handshakes are terminal too`() {
        for (code in listOf(403, 404)) {
            val transport = Transport()
            val sink = Recorder()
            val timer = Timer()
            socket(transport, sink, timer)
            transport.current.onFailure(transport.currentSocket, RuntimeException("no"), response(code))
            assertEquals("code $code", 1, sink.terminals.size)
            assertTrue("code $code", timer.delays.isEmpty())
        }
        assertEquals(setOf(401, 403, 404), ReconnectingSocket.TERMINAL_HANDSHAKE_CODES)
    }

    @Test
    fun `a 500 handshake still reconnects - the node may be restarting`() {
        val transport = Transport()
        val sink = Recorder()
        val timer = Timer()
        socket(transport, sink, timer)

        transport.current.onFailure(transport.currentSocket, RuntimeException("boom"), response(503))

        assertTrue(sink.terminals.isEmpty())
        assertEquals(1, sink.closes)
        assertEquals(1, timer.delays.size)
    }

    @Test
    fun `close cancels a pending reconnect and the live socket`() {
        val transport = Transport()
        val sink = Recorder()
        val timer = Timer()
        val subscription = socket(transport, sink, timer)

        transport.current.onOpen(transport.currentSocket, response(101))
        transport.current.onClosed(transport.currentSocket, 1006, "gone")
        assertEquals(1, timer.delays.size)

        subscription.close()
        assertEquals(1, timer.cancels)
        assertTrue(transport.currentSocket.cancelled)

        // A timer that fired anyway must not resurrect the socket.
        timer.fire()
        assertEquals(1, transport.urls.size)
    }

    @Test
    fun `a terminal failure leaves nothing to reconnect after close`() {
        val transport = Transport()
        val sink = Recorder()
        val timer = Timer()
        socket(transport, sink, timer)

        transport.current.onFailure(transport.currentSocket, RuntimeException("no"), response(401))
        // Further frames on the dead socket are ignored, not re-reported.
        transport.current.onClosed(transport.currentSocket, 1006, "after")
        assertEquals(1, sink.terminals.size)
        assertEquals(0, sink.closes)
        assertTrue(timer.delays.isEmpty())
    }

    @Test
    fun `an open that lands after close cancels the socket`() {
        val transport = Transport()
        val sink = Recorder()
        val subscription = socket(transport, sink, Timer())
        subscription.close()

        transport.current.onOpen(transport.currentSocket, response(101))
        assertEquals(0, sink.opens)
        assertTrue(transport.currentSocket.cancelled)
    }
}

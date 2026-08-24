package dev.rivetos.bots.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.Closeable
import kotlin.random.Random

/**
 * Reconnecting WebSocket for WS /api/terminal/ws.
 *
 * Same client-order / backoff / generation rules as [WsSubscription], plus
 * [WebSocketListener.onMessage] ByteString for binary PTY frames. Detach
 * closes the socket; the caller must never send `{type:kill}`.
 *
 * After an exit frame the server closes cleanly — set [reconnectOnClose]
 * false so we do not hammer a reaped PTY.
 */
class TermWs(
    private val clientOrder: List<OkHttpClient>,
    private val url: String,
    private val onStatus: (WsStatus) -> Unit,
    private val onText: (String) -> Unit,
    private val onBinary: (ByteArray) -> Unit,
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var closed = false
    @Volatile private var ws: WebSocket? = null
    @Volatile private var generation = 0
    @Volatile private var reconnectJob: Job? = null
    @Volatile private var attempt = 0
    @Volatile var reconnectOnClose: Boolean = true

    init { connect() }

    fun sendText(text: String): Boolean = ws?.send(text) == true

    fun sendBinary(bytes: ByteArray): Boolean {
        val socket = ws ?: return false
        return socket.send(bytes.toByteString())
    }

    private fun connect() {
        if (closed) return
        val myGen = ++generation
        val old = ws
        ws = null
        old?.cancel()
        onStatus(WsStatus.CONNECTING)
        val req = Request.Builder().url(url).build()
        val client = clientOrder[attempt % clientOrder.size]
        val socket = client.newWebSocket(req, object : WebSocketListener() {
            private fun live(): Boolean = !closed && myGen == generation
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!live()) { webSocket.cancel(); return }
                attempt = 0
                onStatus(WsStatus.OPEN)
            }
            override fun onMessage(webSocket: WebSocket, text: String) { if (live()) onText(text) }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (live()) onBinary(bytes.toByteArray())
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (live()) reconnect() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (live()) reconnect() }
        })
        ws = socket
        if (closed) socket.cancel()
    }

    private fun reconnect() {
        onStatus(WsStatus.CLOSED)
        if (closed || !reconnectOnClose) return
        synchronized(this) {
            if (reconnectJob?.isActive == true) return
            val backoff = minOf(500L shl minOf(attempt, 6), 15_000L)
            attempt += 1
            reconnectJob = scope.launch {
                delay(backoff + Random.nextLong(0, 250))
                reconnectJob = null
                connect()
            }
        }
    }

    override fun close() {
        closed = true
        reconnectOnClose = false
        reconnectJob?.cancel()
        ws?.close(1000, null)
        scope.cancel()
    }
}

/**
 * OSC 10/11/12 color-query filter — twin of rivethub-web `lib/osc-filter.ts`.
 *
 * Harnesses emit OSC 11? on startup; a real xterm answers with the theme
 * background via stdin, which then shows up as garbage `]11;rgb:…` in the TUI.
 * Strip queries from PTY output and never forward a report as keystrokes.
 */
object OscFilter {
    fun stripQueries(data: ByteArray): ByteArray {
        if (data.isEmpty()) return data
        val s = String(data, Charsets.ISO_8859_1)
        val cleaned = OSC_COLOR_QUERY.replace(s, "")
        if (cleaned.length == s.length) return data
        return cleaned.toByteArray(Charsets.ISO_8859_1)
    }

    fun isColorReport(data: String): Boolean = OSC_COLOR_REPORT.containsMatchIn(data)

    // ESC ] (10|11|12) ; ?  BEL   or   ESC ] … ST (ESC \)
    private val OSC_COLOR_QUERY = Regex("\u001b\\](?:10|11|12);\\?(?:\u0007|\u001b\\\\)")
    private val OSC_COLOR_REPORT = Regex("(?:\u001b)?\\](?:10|11|12);rgb:", RegexOption.IGNORE_CASE)
}

package io.rivethub.app.gateway

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.Closeable

/**
 * Reconnecting WebSocket for WS /api/terminal/ws.
 *
 * Same client-order / [ReconnectScheduler] / generation rules as [WsSubscription], plus
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
    @Volatile private var status = WsStatus.CONNECTING
    @Volatile var reconnectOnClose: Boolean = true
    private val retry = ReconnectScheduler(scope) { connect() }
    private val foreground = AppForeground.register { fg, away ->
        if (!fg) retry.pause()
        else if (reconnectOnClose && reconnectOnForeground(status, away)) retry.connectNow()
    }

    init { connect() }

    fun sendText(text: String): Boolean = ws?.send(text) == true

    fun sendBinary(bytes: ByteArray): Boolean {
        val socket = ws ?: return false
        return socket.send(bytes.toByteString())
    }

    private fun publish(next: WsStatus) {
        status = next
        onStatus(next)
    }

    private fun connect() {
        if (closed) return
        val myGen = ++generation
        val old = ws
        ws = null
        old?.cancel()
        publish(WsStatus.CONNECTING)
        val req = Request.Builder().url(url).build()
        val client = clientOrder[retry.attempt % clientOrder.size]
        val socket = client.newWebSocket(req, object : WebSocketListener() {
            private fun live(): Boolean = !closed && myGen == generation
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!live()) { webSocket.cancel(); return }
                retry.onOpen()
                publish(WsStatus.OPEN)
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
        publish(WsStatus.CLOSED)
        if (closed || !reconnectOnClose) return
        retry.schedule()
    }

    override fun close() {
        closed = true
        reconnectOnClose = false
        foreground.close()
        retry.cancel()
        ws?.close(1000, null)
        scope.cancel()
    }
}

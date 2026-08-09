package dev.rivet.app.data.harness

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Callbacks off a control-plane socket. */
interface HarnessStreamListener {
    /**
     * A fresh attach. The tail has no replay, so the caller MUST hard-resync
     * the transcript here — first connect and every reconnect alike.
     */
    fun onOpen() {}

    fun onEvent(event: HarnessEvent)

    fun onClosed() {}

    /**
     * The handshake was refused in a way retrying cannot fix — the bearer is
     * wrong or the route is not there. The socket has already stopped itself;
     * reconnecting would just re-ask the same question on every radio flap.
     */
    fun onTerminal(message: String) {}
}

/** Handle on a live tail. */
interface HarnessSubscription {
    fun close()
}

/**
 * Reconnecting WS tail — the Kotlin twin of `packages/gateway-client/src/ws.ts`,
 * plus one thing a browser client never has to think about: a phone changes
 * networks constantly, so a handshake the node will always refuse must not
 * become a permanent background retry loop.
 *
 * Base 500ms backoff doubling to a 15s cap with jitter; one pending reconnect
 * at most, so a socket that reports close twice cannot spawn two live sockets.
 *
 * `connect` and `scheduleReconnect` are injected so the terminal-code and
 * backoff behavior are unit-testable without a network.
 */
internal class ReconnectingSocket(
    private val url: () -> String,
    private val listener: HarnessStreamListener,
    private val connectSocket: (String, WebSocketListener) -> WebSocket,
    private val scheduleReconnect: (Long, () -> Unit) -> HarnessCancellable = { delayMs, task ->
        val future = scheduler.schedule(task, delayMs, TimeUnit.MILLISECONDS)
        HarnessCancellable { future.cancel(false) }
    },
) : HarnessSubscription {

    private val closed = AtomicBoolean(false)
    private var socket: WebSocket? = null
    private var attempt = 0
    private var pending: HarnessCancellable? = null

    fun start(): ReconnectingSocket {
        connect()
        return this
    }

    @Synchronized
    private fun connect() {
        if (closed.get()) return
        pending?.cancel()
        pending = null
        socket = connectSocket(
            url(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (closed.get()) {
                        webSocket.cancel()
                        return
                    }
                    attempt = 0
                    listener.onOpen()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (closed.get()) return
                    // A frame we cannot parse must not kill the subscription —
                    // a future server may add non-JSON keepalives.
                    HarnessEvent.parse(text)?.let(listener::onEvent)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    reconnect(null)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    reconnect(response)
                }
            },
        )
    }

    /**
     * A refused handshake carries an HTTP response; a dropped connection does
     * not. Only the former can be terminal, and only for the codes that say
     * "this will never work" rather than "not right now".
     */
    private fun terminalMessage(response: Response?): String? {
        val code = response?.code ?: return null
        if (code !in TERMINAL_HANDSHAKE_CODES) return null
        return when (code) {
            401, 403 -> "not authorized for this node's harness stream ($code)"
            else -> "this node has no harness stream ($code)"
        }
    }

    @Synchronized
    private fun reconnect(response: Response?) {
        if (closed.get()) return
        val terminal = terminalMessage(response)
        if (terminal != null) {
            // Stop first, then report: the listener will tear down whatever it
            // owns, and a reconnect timer armed behind it would outlive that.
            close()
            listener.onTerminal(terminal)
            return
        }
        listener.onClosed()
        if (closed.get()) return // the listener may stop us on a fatal frame
        pending?.cancel()
        val backoff = minOf(BASE_BACKOFF_MS shl minOf(attempt, 8), MAX_BACKOFF_MS)
        attempt += 1
        pending = scheduleReconnect(backoff + (Math.random() * JITTER_MS).toLong()) { connect() }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        synchronized(this) {
            pending?.cancel()
            pending = null
            // cancel(), not close(): aborts a connect in flight too.
            runCatching { socket?.cancel() }
            socket = null
        }
    }

    companion object {
        const val BASE_BACKOFF_MS = 500L
        const val MAX_BACKOFF_MS = 15_000L
        const val JITTER_MS = 250L

        /**
         * Handshake codes no amount of retrying fixes. 404 is here because a
         * node too old to mount the route answers it forever; 401/403 because
         * a bearer that is wrong now is wrong on the next radio flap too.
         */
        val TERMINAL_HANDSHAKE_CODES = setOf(401, 403, 404)

        /** One daemon timer for every tail in the process. */
        private val scheduler: ScheduledExecutorService =
            Executors.newSingleThreadScheduledExecutor { r ->
                Thread(r, "harness-ws-reconnect").apply { isDaemon = true }
            }

        /**
         * The real transport: a socket on the shared OkHttp pool, with the
         * bearer on the upgrade request.
         *
         * den's gate reads `Authorization` on an upgrade exactly as it does on a
         * GET, and accepts `?token=` only because a browser's `WebSocket`
         * constructor cannot set headers. OkHttp can, so the credential never
         * enters a URL that a proxy or access log might keep.
         */
        fun over(client: OkHttpClient, token: String? = null): (String, WebSocketListener) -> WebSocket =
            { url, listener -> client.newWebSocket(upgradeRequest(url, token), listener) }

        /** The handshake request [over] sends; separate so it is assertable. */
        fun upgradeRequest(url: String, token: String?): Request {
            val bearer = token?.trim().orEmpty()
            val builder = Request.Builder().url(url)
            if (bearer.isNotEmpty()) builder.header("Authorization", "Bearer $bearer")
            return builder.build()
        }
    }
}

/** Retained so a scheduled reconnect (or settle) can be called off. */
fun interface HarnessCancellable {
    fun cancel()
}

private fun ScheduledExecutorService.schedule(
    task: () -> Unit,
    delayMs: Long,
    unit: TimeUnit,
): ScheduledFuture<*> = schedule(Runnable { task() }, delayMs, unit)

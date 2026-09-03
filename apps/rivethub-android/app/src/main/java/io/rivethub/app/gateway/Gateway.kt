package io.rivethub.app.gateway

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.Closeable
import java.io.IOException
import kotlin.random.Random

open class GatewayException(val status: Int, message: String) : IOException(message)

/**
 * Typed client over one node's gateway — the Kotlin twin of
 * `@rivetos/gateway-client` RivetGateway, scoped to what a bot client needs.
 */
class Gateway(
    private val primary: OkHttpClient,
    baseUrl: String,
    private val fallback: OkHttpClient? = null,
) {
    val baseUrl: String = baseUrl.trimEnd('/')
    private val base: HttpUrl = this.baseUrl.toHttpUrl()

    /** Sticks to whichever client last worked; a connect timeout flips it. */
    @Volatile private var preferFallback = false

    private fun clients(): List<OkHttpClient> {
        val f = fallback ?: return listOf(primary)
        return if (preferFallback) listOf(f, primary) else listOf(primary, f)
    }

    /** Run [block] with the preferred client; retry once on the other path when connecting fails. */
    private inline fun <T> withClients(block: (OkHttpClient) -> T): T {
        val order = clients()
        var last: Exception? = null
        for ((i, c) in order.withIndex()) {
            try {
                val out = block(c)
                if (i == 1) preferFallback = c === fallback
                return out
            } catch (e: Exception) {
                val connectFailure = e is java.net.SocketTimeoutException || e is java.net.ConnectException ||
                    e is java.net.NoRouteToHostException
                if (!connectFailure || i == order.lastIndex) throw e
                last = e
            }
        }
        throw last!!
    }

    /** Appends to the configured base path (a node behind `https://host/rivet` keeps its prefix). */
    private fun url(segments: List<String>, query: Map<String, String?> = emptyMap()): HttpUrl {
        val b = base.newBuilder()
        segments.forEach { b.addPathSegment(it) }
        query.forEach { (k, v) -> if (v != null) b.addQueryParameter(k, v) }
        return b.build()
    }

    private suspend fun <T> get(segments: List<String>, ser: KSerializer<T>, query: Map<String, String?> = emptyMap()): T =
        withContext(Dispatchers.IO) {
            withClients { c ->
                c.newCall(Request.Builder().url(url(segments, query)).get().build()).execute().use { res ->
                    val body = res.body.string()
                    if (!res.isSuccessful) throw GatewayException(res.code, errorText(res, body))
                    wireJson.decodeFromString(ser, body)
                }
            }
        }

    private fun errorText(res: Response, body: String): String {
        val msg = runCatching {
            wireJson.parseToJsonElement(body).let { (it as? kotlinx.serialization.json.JsonObject)?.get("error") }
                ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
        }.getOrNull()
        return msg ?: "HTTP ${res.code}"
    }

    suspend fun healthz(): Healthz = get(listOf("healthz"), Healthz.serializer())
    suspend fun mesh(): MeshOverview = get(listOf("api", "mesh"), MeshOverview.serializer())
    suspend fun catalogAgents(): CatalogAgentsResponse = get(listOf("api", "catalog", "agents"), CatalogAgentsResponse.serializer())
    suspend fun sessions(): SessionsListResponse = get(listOf("api", "sessions"), SessionsListResponse.serializer())

    suspend fun messages(sessionId: String): List<SessionMessage> =
        get(listOf("api", "sessions", sessionId, "messages"), SessionMessagesResponse.serializer()).messages

    suspend fun post(sessionId: String, text: String, userId: String?, agent: String?): SessionPostAccepted =
        withContext(Dispatchers.IO) {
            val body = wireJson.encodeToString(SessionPostRequest.serializer(), SessionPostRequest(text, userId, agent))
                .toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url(url(listOf("api", "sessions", sessionId, "messages"))).post(body).build()
            withClients { c ->
                c.newCall(req).execute().use { res ->
                    val text2 = res.body.string()
                    if (!res.isSuccessful) throw GatewayException(res.code, errorText(res, text2))
                    // A 2xx is the acceptance signal; an odd/empty body (a proxy, say) must not
                    // turn a turn that is already running server-side into a "send failed".
                    runCatching { wireJson.decodeFromString(SessionPostAccepted.serializer(), text2) }
                        .getOrDefault(SessionPostAccepted(true, sessionId))
                }
            }
        }

    /** Throws on transport/auth errors; a 404 (no room yet) is a GatewayException(404). */
    suspend fun denState(sessionId: String): RoomState? =
        get(listOf("api", "events", "state"), DenStateResponse.serializer(), mapOf("session" to sessionId)).state

    /** Live message/stream frames; null sessionId watches every session on the node. */
    fun watchSessions(sessionId: String?, onFrame: (SessionFrame) -> Unit, onStatus: (WsStatus) -> Unit = {}): Closeable =
        WsSubscription(clients(), url(listOf("api", "sessions", "ws"), mapOf("session" to sessionId)).toString(), onStatus) { text ->
            parseSessionFrame(text)?.let(onFrame)
        }

    fun watchDen(sessionId: String?, onFrame: (DenFrame) -> Unit, onStatus: (WsStatus) -> Unit = {}): Closeable =
        WsSubscription(clients(), url(listOf("api", "events", "ws"), mapOf("session" to sessionId)).toString(), onStatus) { text ->
            parseDenFrame(text)?.let(onFrame)
        }

    suspend fun termConfig(): TermConfigResponse =
        get(listOf("api", "terminal", "config"), TermConfigResponse.serializer())

    suspend fun termList(): TermListResponse =
        get(listOf("api", "terminal", "list"), TermListResponse.serializer())

    /**
     * Spawn-or-get a PTY. Passing [session] joins it to this conversation
     * (chat / den / terminal = three views of one session).
     */
    suspend fun termSpawn(session: String, cols: Int, rows: Int, command: String? = null): TermSpawnResponse =
        withContext(Dispatchers.IO) {
            val body = wireJson.encodeToString(
                TermSpawnRequest.serializer(),
                TermSpawnRequest(
                    command = command,
                    session = session,
                    cols = cols.coerceIn(20, 500),
                    rows = rows.coerceIn(5, 200),
                ),
            ).toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url(url(listOf("api", "terminal"))).post(body).build()
            withClients { c ->
                c.newCall(req).execute().use { res ->
                    val text = res.body.string()
                    if (!res.isSuccessful) throw GatewayException(res.code, errorText(res, text))
                    wireJson.decodeFromString(TermSpawnResponse.serializer(), text)
                }
            }
        }

    /**
     * Attach to a PTY. den-server accepts `?id=` or `?session=` (verified in
     * term/ws.ts handleUpgrade). Prefer [ptyId] after a spawn so we do not
     * race a missing session mapping.
     */
    fun watchTerm(
        ptyId: String?,
        sessionId: String? = null,
        onText: (String) -> Unit,
        onBinary: (ByteArray) -> Unit,
        onStatus: (WsStatus) -> Unit = {},
    ): TermWs = TermWs(
        clients(),
        url(listOf("api", "terminal", "ws"), mapOf("id" to ptyId, "session" to sessionId)).toString(),
        onStatus, onText, onBinary,
    )

}

enum class WsStatus { CONNECTING, OPEN, CLOSED }

/**
 * Reconnecting WebSocket: base 500ms, doubling, capped at 15s, jittered.
 * One socket at a time, identified by a generation number captured in its
 * listener — no lock is held across OkHttp calls (its callbacks can re-enter
 * from `cancel()`/`close()`), and a late `onOpen` from a superseded socket
 * can't report OPEN or reset the backoff.
 */
class WsSubscription(
    private val clientOrder: List<OkHttpClient>,
    private val url: String,
    private val onStatus: (WsStatus) -> Unit,
    private val onText: (String) -> Unit,
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var closed = false
    @Volatile private var ws: WebSocket? = null
    @Volatile private var generation = 0
    @Volatile private var reconnectJob: Job? = null
    @Volatile private var attempt = 0

    init { connect() }

    private fun connect() {
        if (closed) return
        val myGen = ++generation
        val old = ws
        ws = null
        old?.cancel()
        onStatus(WsStatus.CONNECTING)
        val req = Request.Builder().url(url).build()
        // Alternate network paths across attempts — whichever one works wins.
        val client = clientOrder[attempt % clientOrder.size]
        val socket = client.newWebSocket(req, object : WebSocketListener() {
            private fun live(): Boolean = !closed && myGen == generation
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!live()) { webSocket.cancel(); return }
                attempt = 0
                onStatus(WsStatus.OPEN)
            }
            override fun onMessage(webSocket: WebSocket, text: String) { if (live()) onText(text) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (live()) reconnect() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (live()) reconnect() }
        })
        ws = socket
        if (closed) socket.cancel() // close() raced us between the check above and the publish
    }

    private fun reconnect() {
        onStatus(WsStatus.CLOSED)
        if (closed) return
        synchronized(this) { // only guards the job handoff; no OkHttp call inside
            if (reconnectJob?.isActive == true) return
            val backoff = minOf(500L shl minOf(attempt, 6), 15_000L)
            attempt += 1
            reconnectJob = scope.launch {
                delay(backoff + Random.nextLong(0, 250))
                reconnectJob = null // a failure raised from inside connect() must be able to schedule the next try
                connect()
            }
        }
    }

    override fun close() {
        closed = true
        reconnectJob?.cancel()
        ws?.close(1000, null)
        scope.cancel()
    }
}

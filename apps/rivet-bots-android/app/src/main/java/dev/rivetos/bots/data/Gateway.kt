package dev.rivetos.bots.data

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

class GatewayException(val status: Int, message: String) : IOException(message)

/**
 * Typed client over one node's gateway — the Kotlin twin of
 * `@rivetos/gateway-client` RivetGateway, scoped to what a bot client needs.
 */
class Gateway(private val client: OkHttpClient, baseUrl: String) {
    val baseUrl: String = baseUrl.trimEnd('/')
    private val base: HttpUrl = this.baseUrl.toHttpUrl()

    /** Appends to the configured base path (a node behind `https://host/rivet` keeps its prefix). */
    private fun url(segments: List<String>, query: Map<String, String?> = emptyMap()): HttpUrl {
        val b = base.newBuilder()
        segments.forEach { b.addPathSegment(it) }
        query.forEach { (k, v) -> if (v != null) b.addQueryParameter(k, v) }
        return b.build()
    }

    private suspend fun <T> get(segments: List<String>, ser: KSerializer<T>, query: Map<String, String?> = emptyMap()): T =
        withContext(Dispatchers.IO) {
            client.newCall(Request.Builder().url(url(segments, query)).get().build()).execute().use { res ->
                val body = res.body.string()
                if (!res.isSuccessful) throw GatewayException(res.code, errorText(res, body))
                wireJson.decodeFromString(ser, body)
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
            client.newCall(req).execute().use { res ->
                val text2 = res.body.string()
                if (!res.isSuccessful) throw GatewayException(res.code, errorText(res, text2))
                runCatching { wireJson.decodeFromString(SessionPostAccepted.serializer(), text2) }
                    .getOrElse { throw GatewayException(res.code, "unexpected reply from gateway") }
            }
        }

    /** Throws on transport/auth errors; a 404 (no room yet) is a GatewayException(404). */
    suspend fun denState(sessionId: String): RoomState? =
        get(listOf("api", "events", "state"), DenStateResponse.serializer(), mapOf("session" to sessionId)).state

    /** Live message/stream frames; null sessionId watches every session on the node. */
    fun watchSessions(sessionId: String?, onFrame: (SessionFrame) -> Unit, onStatus: (WsStatus) -> Unit = {}): Closeable =
        WsSubscription(client, url(listOf("api", "sessions", "ws"), mapOf("session" to sessionId)).toString(), onStatus) { text ->
            parseSessionFrame(text)?.let(onFrame)
        }

    fun watchDen(sessionId: String?, onFrame: (DenFrame) -> Unit, onStatus: (WsStatus) -> Unit = {}): Closeable =
        WsSubscription(client, url(listOf("api", "events", "ws"), mapOf("session" to sessionId)).toString(), onStatus) { text ->
            parseDenFrame(text)?.let(onFrame)
        }

}

enum class WsStatus { CONNECTING, OPEN, CLOSED }

/** Reconnecting WebSocket: base 500ms, doubling, capped at 15s, jittered. One socket, one pending reconnect. */
class WsSubscription(
    private val client: OkHttpClient,
    private val url: String,
    private val onStatus: (WsStatus) -> Unit,
    private val onText: (String) -> Unit,
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    @Volatile private var closed = false
    private var ws: WebSocket? = null
    private var reconnectJob: Job? = null
    private var attempt = 0

    init { connect() }

    private fun connect() {
        synchronized(lock) {
            if (closed) return
            reconnectJob?.cancel(); reconnectJob = null
            ws?.cancel() // never two live sockets for one subscription
            onStatus(WsStatus.CONNECTING)
            val req = Request.Builder().url(url).build()
            var self: WebSocket? = null
            self = client.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (closed) { webSocket.close(1000, null); return }
                    attempt = 0
                    onStatus(WsStatus.OPEN)
                }
                override fun onMessage(webSocket: WebSocket, text: String) { if (!closed && isCurrent(webSocket)) onText(text) }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (isCurrent(webSocket)) reconnect() }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (isCurrent(webSocket)) reconnect() }
            })
            ws = self
        }
    }

    private fun isCurrent(socket: WebSocket): Boolean = synchronized(lock) { socket === ws }

    private fun reconnect() {
        synchronized(lock) {
            onStatus(WsStatus.CLOSED)
            if (closed || reconnectJob?.isActive == true) return
            val backoff = minOf(500L shl minOf(attempt, 6), 15_000L)
            attempt += 1
            reconnectJob = scope.launch {
                delay(backoff + Random.nextLong(0, 250))
                connect()
            }
        }
    }

    override fun close() {
        synchronized(lock) {
            closed = true
            reconnectJob?.cancel()
            ws?.close(1000, null)
        }
        scope.cancel()
    }
}

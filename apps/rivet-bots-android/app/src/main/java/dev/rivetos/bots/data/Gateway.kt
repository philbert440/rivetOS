package dev.rivetos.bots.data

import kotlinx.coroutines.CoroutineScope
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

    private fun url(path: String, query: Map<String, String?> = emptyMap()): HttpUrl {
        val b = base.newBuilder().encodedPath(path)
        query.forEach { (k, v) -> if (v != null) b.addQueryParameter(k, v) }
        return b.build()
    }

    private suspend fun <T> get(path: String, ser: KSerializer<T>, query: Map<String, String?> = emptyMap()): T =
        withContext(Dispatchers.IO) {
            client.newCall(Request.Builder().url(url(path, query)).get().build()).execute().use { res ->
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

    suspend fun healthz(): Healthz = get("/healthz", Healthz.serializer())
    suspend fun mesh(): MeshOverview = get("/api/mesh", MeshOverview.serializer())
    suspend fun catalogAgents(): CatalogAgentsResponse = get("/api/catalog/agents", CatalogAgentsResponse.serializer())
    suspend fun sessions(): SessionsListResponse = get("/api/sessions", SessionsListResponse.serializer())

    suspend fun messages(sessionId: String): List<SessionMessage> =
        get("/api/sessions/${enc(sessionId)}/messages", SessionMessagesResponse.serializer()).messages

    suspend fun post(sessionId: String, text: String, userId: String?, agent: String?): SessionPostAccepted =
        withContext(Dispatchers.IO) {
            val body = wireJson.encodeToString(SessionPostRequest.serializer(), SessionPostRequest(text, userId, agent))
                .toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url(url("/api/sessions/${enc(sessionId)}/messages")).post(body).build()
            client.newCall(req).execute().use { res ->
                val text2 = res.body.string()
                if (!res.isSuccessful) throw GatewayException(res.code, errorText(res, text2))
                runCatching { wireJson.decodeFromString(SessionPostAccepted.serializer(), text2) }
                    .getOrDefault(SessionPostAccepted(true, sessionId))
            }
        }

    suspend fun denState(sessionId: String): RoomState? = runCatching {
        get("/api/events/state", DenStateResponse.serializer(), mapOf("session" to sessionId)).state
    }.getOrNull()

    /** Live message/stream frames; null sessionId watches every session on the node. */
    fun watchSessions(sessionId: String?, onFrame: (SessionFrame) -> Unit, onStatus: (WsStatus) -> Unit = {}): Closeable =
        WsSubscription(client, wsUrl("/api/sessions/ws", mapOf("session" to sessionId)), onStatus) { text ->
            parseSessionFrame(text)?.let(onFrame)
        }

    fun watchDen(sessionId: String?, onFrame: (DenFrame) -> Unit, onStatus: (WsStatus) -> Unit = {}): Closeable =
        WsSubscription(client, wsUrl("/api/events/ws", mapOf("session" to sessionId)), onStatus) { text ->
            parseDenFrame(text)?.let(onFrame)
        }

    private fun wsUrl(path: String, query: Map<String, String?>): String {
        val u = url(path, query).newBuilder()
        // OkHttp accepts ws/wss schemes on Request.url; keep http(s) and let it upgrade.
        return u.build().toString()
    }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}

enum class WsStatus { CONNECTING, OPEN, CLOSED }

/** Reconnecting WebSocket: base 500ms, doubling, capped at 15s, jittered. */
class WsSubscription(
    private val client: OkHttpClient,
    private val url: String,
    private val onStatus: (WsStatus) -> Unit,
    private val onText: (String) -> Unit,
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var closed = false
    @Volatile private var ws: WebSocket? = null
    private var attempt = 0

    init { connect() }

    private fun connect() {
        if (closed) return
        onStatus(WsStatus.CONNECTING)
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (closed) { webSocket.close(1000, null); return }
                attempt = 0
                onStatus(WsStatus.OPEN)
            }
            override fun onMessage(webSocket: WebSocket, text: String) { onText(text) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { reconnect() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { reconnect() }
        })
    }

    private fun reconnect() {
        onStatus(WsStatus.CLOSED)
        if (closed) return
        val backoff = minOf(500L shl minOf(attempt, 6), 15_000L)
        attempt += 1
        scope.launch {
            delay(backoff + Random.nextLong(0, 250))
            connect()
        }
    }

    override fun close() {
        closed = true
        ws?.close(1000, null)
        scope.cancel()
    }
}

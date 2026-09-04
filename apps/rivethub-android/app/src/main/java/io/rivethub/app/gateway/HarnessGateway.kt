package io.rivethub.app.gateway

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.Closeable

/**
 * Typed harness-plane client over one node's gateway. Intentionally has no
 * startSession: hermes, kimi and dsh reject it with capability_unsupported,
 * and + new mints a bare-UUID draft instead.
 */
class HarnessGateway(
    private val primary: OkHttpClient,
    baseUrl: String,
    private val fallback: OkHttpClient? = null,
) {
    val baseUrl: String = baseUrl.trimEnd('/')
    private val base: HttpUrl = this.baseUrl.toHttpUrl()

    @Volatile private var preferFallback = false

    private fun clients(): List<OkHttpClient> {
        val f = fallback ?: return listOf(primary)
        return if (preferFallback) listOf(f, primary) else listOf(primary, f)
    }

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

    internal fun url(segments: List<String>, query: Map<String, String?> = emptyMap()): HttpUrl {
        val b = base.newBuilder()
        segments.forEach { b.addPathSegment(it) }
        query.forEach { (k, v) -> if (v != null) b.addQueryParameter(k, v) }
        return b.build()
    }

    fun sessionWatchUrl(enc: String): String =
        url(listOf("api", "harness-sessions", "ws"), mapOf("session" to enc)).toString()

    fun registryWatchUrl(harnessId: String? = null): String =
        url(
            listOf("api", "harnesses", "ws"),
            mapOf("harness" to harnessId?.takeIf { it.isNotBlank() }),
        ).toString()

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
            wireJson.parseToJsonElement(body).let { (it as? JsonObject)?.get("error") }
                ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
        }.getOrNull()
        return msg ?: "HTTP ${res.code}"
    }

    private fun bodyCode(body: String): String? = runCatching {
        (wireJson.parseToJsonElement(body) as? JsonObject)?.get("code")?.jsonPrimitive?.contentOrNull
    }.getOrNull()

    suspend fun listHarnesses(): List<HarnessDescriptor> =
        get(listOf("api", "harnesses"), HarnessesResponse.serializer()).harnesses

    /**
     * One driver's sessions. When [capabilities] is supplied and
     * listSessions is false, returns empty without hitting the node
     * (a false flag answers HTTP 501).
     */
    suspend fun listSessions(harnessId: String, capabilities: HarnessCapabilities? = null): List<HarnessSessionSummary> {
        if (capabilities != null && !capabilities.listSessions) return emptyList()
        return get(
            listOf("api", "harnesses", harnessId, "sessions"),
            HarnessSessionListResponse.serializer(),
        ).sessions
    }

    suspend fun listSessions(descriptor: HarnessDescriptor): List<HarnessSessionSummary> =
        listSessions(descriptor.harnessId, descriptor.capabilities)

    suspend fun legacySessions(): List<LegacyHarnessSession> =
        get(listOf("api", "terminal", "harness-sessions"), LegacyHarnessSessionsResponse.serializer()).sessions

    /** POST /api/harness-sessions/{enc}/turns. 409 turn_in_flight → [TurnInFlight]. */
    suspend fun sendTurn(enc: String, turn: UserTurn): HarnessTurnAccepted =
        withContext(Dispatchers.IO) {
            val body = wireJson.encodeToString(UserTurn.serializer(), turn)
                .toRequestBody("application/json".toMediaType())
            val req = Request.Builder()
                .url(url(listOf("api", "harness-sessions", enc, "turns")))
                .post(body)
                .build()
            withClients { c ->
                c.newCall(req).execute().use { res ->
                    val text = res.body.string()
                    if (res.code == 409 && bodyCode(text) == "turn_in_flight") {
                        throw TurnInFlight(errorText(res, text))
                    }
                    if (!res.isSuccessful) throw GatewayException(res.code, errorText(res, text))
                    runCatching { wireJson.decodeFromString(HarnessTurnAccepted.serializer(), text) }
                        .getOrDefault(HarnessTurnAccepted(true))
                }
            }
        }

    /**
     * Live tail for one session (`WS /api/harness-sessions/ws?session=`). Same
     * reconnecting, generation-guarded, at-most-once shape as Gateway.watchSessions.
     * Every OPEN is a fresh attach — the caller hard-replaces the transcript.
     * A fatal error frame closes the socket so we do not reconnect into the
     * same refusal forever.
     */
    fun watchSession(
        enc: String,
        onEvent: (HarnessEvent) -> Unit,
        onStatus: (WsStatus) -> Unit = {},
    ): Closeable {
        val box = arrayOfNulls<Closeable>(1)
        val sub = WsSubscription(clients(), sessionWatchUrl(enc), onStatus) { text ->
            val event = parseHarnessEvent(text) ?: return@WsSubscription
            if (isFatalHarnessEvent(event)) box[0]?.close()
            onEvent(event)
        }
        box[0] = sub
        return sub
    }

    /** Driver-level registry stream across every session. */
    fun watchRegistry(harnessId: String? = null, onEvent: (HarnessEvent) -> Unit,
        onStatus: (WsStatus) -> Unit = {},
    ): Closeable = WsSubscription(clients(), registryWatchUrl(harnessId), onStatus) { text ->
        parseHarnessEvent(text)?.let(onEvent)
    }

    /** GET /api/harness-sessions/{enc}/transcript — hard-resync source of truth. */
    suspend fun transcript(enc: String): HarnessSessionTranscriptResponse =
        get(listOf("api", "harness-sessions", enc, "transcript"), HarnessSessionTranscriptResponse.serializer())

    /** POST /api/harness-sessions/{enc}/interrupt — stop the in-flight turn. */
    suspend fun interrupt(enc: String): HarnessTurnAccepted =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url(url(listOf("api", "harness-sessions", enc, "interrupt")))
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build()
            withClients { c ->
                c.newCall(req).execute().use { res ->
                    val text = res.body.string()
                    if (!res.isSuccessful) throw GatewayException(res.code, errorText(res, text))
                    runCatching { wireJson.decodeFromString(HarnessTurnAccepted.serializer(), text) }
                        .getOrDefault(HarnessTurnAccepted(true))
                }
            }
        }

    /** POST /api/uploads — stage bytes on THIS node (the session's node). */
    suspend fun stageUpload(bytes: ByteArray, name: String, mime: String? = null): StagedUploadResponse =
        stageUpload(bytes.size.toLong(), name, mime) { bytes.inputStream() }

    /** Stream an upload without materialising a ByteArray. Caps at 1 GiB. */
    suspend fun stageUpload(
        contentLength: Long,
        name: String,
        mime: String? = null,
        open: () -> java.io.InputStream,
    ): StagedUploadResponse =
        withContext(Dispatchers.IO) {
            val media = (mime ?: "application/octet-stream").toMediaType()
            val body = object : RequestBody() {
                override fun contentType() = media
                override fun contentLength(): Long = if (contentLength >= 0) contentLength else -1L
                override fun writeTo(sink: okio.BufferedSink) {
                    open().use { input ->
                        val buf = ByteArray(8192)
                        var copied = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            copied += n
                            if (copied > UPLOAD_CAP_BYTES) throw java.io.IOException("upload exceeds 1 GiB cap")
                            sink.write(buf, 0, n)
                        }
                    }
                }
            }
            val req = Request.Builder()
                .url(url(listOf("api", "uploads"), mapOf("name" to name, "mime" to mime)))
                .post(body)
                .build()
            withClients { c ->
                c.newCall(req).execute().use { res ->
                    val text = res.body.string()
                    if (!res.isSuccessful) throw GatewayException(res.code, errorText(res, text))
                    wireJson.decodeFromString(StagedUploadResponse.serializer(), text)
                }
            }
        }

    companion object {
        private const val UPLOAD_CAP_BYTES = 1024L * 1024L * 1024L
    }
}

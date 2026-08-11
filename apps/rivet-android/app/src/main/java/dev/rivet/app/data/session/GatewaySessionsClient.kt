package dev.rivet.app.data.session

import dev.rivet.app.ui.pages.terminal.DenTermClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Kotlin client for the gateway chat channel (`/api/sessions`).
 *
 * Same contract as `@rivetos/gateway-client` RivetGateway session APIs:
 * create/attach by posting to a session id, list for the drawer, messages for
 * backfill. Auth is mTLS (device cert on the shared OkHttp client) plus an
 * optional per-node bearer on the `Authorization` header — never in the URL.
 *
 * Blocking by design — callers run on `Dispatchers.IO`.
 */
class GatewaySessionsClient(
    denBaseUrl: String,
    private val token: String? = null,
    client: OkHttpClient? = null,
) {
    private val shared: OkHttpClient = client ?: DenTermClient.sharedClient()
    private val http: OkHttpClient = shared.newBuilder()
        .readTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
        .callTimeout(CALL_TIMEOUT_SEC, TimeUnit.SECONDS)
        .build()
    private val waitHttp: OkHttpClient = shared.newBuilder()
        .readTimeout(WAIT_READ_TIMEOUT_SEC, TimeUnit.SECONDS)
        .callTimeout(WAIT_CALL_TIMEOUT_SEC, TimeUnit.SECONDS)
        .build()
    private val base: String = denBaseUrl.trim().trimEnd('/')

    data class SessionSummary(
        val id: String,
        val lastActive: Long,
        val messages: Int,
    )

    data class SessionMessage(
        val id: String,
        val sessionId: String,
        val role: String,
        val text: String,
        val ts: Long,
    )

    fun listSessions(): List<SessionSummary> {
        val json = getJson("/api/sessions")
        val arr = json.optJSONArray("sessions") ?: JSONArray()
        val out = ArrayList<SessionSummary>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("id").trim()
            if (id.isEmpty()) continue
            out.add(
                SessionSummary(
                    id = id,
                    lastActive = o.optLong("lastActive", 0L),
                    messages = o.optInt("messages", 0),
                ),
            )
        }
        return out
    }

    fun messages(sessionId: String): List<SessionMessage> {
        val enc = java.net.URLEncoder.encode(sessionId, Charsets.UTF_8.name())
        val json = getJson("/api/sessions/$enc/messages")
        return parseMessages(json.optJSONArray("messages") ?: JSONArray(), sessionId)
    }

    /**
     * Fire-and-forget turn (202). Replies arrive on the sessions WS when a
     * subscriber is attached; for a simple request/response use [postAndWait].
     */
    fun postMessage(
        sessionId: String,
        text: String,
        agent: String? = null,
        thinking: String? = null,
    ): String {
        val enc = java.net.URLEncoder.encode(sessionId, Charsets.UTF_8.name())
        val body = turnBody(text, agent, thinking)
        val json = postJson("/api/sessions/$enc/messages", body, wait = false)
        return json.optString("session", sessionId)
    }

    /** Long-poll: blocks until the assistant reply (or the server 504s). */
    fun postAndWait(
        sessionId: String,
        text: String,
        agent: String? = null,
        thinking: String? = null,
        timeoutMs: Long = DEFAULT_WAIT_MS,
    ): SessionMessage {
        val enc = java.net.URLEncoder.encode(sessionId, Charsets.UTF_8.name())
        val body = turnBody(text, agent, thinking)
        val path = "/api/sessions/$enc/messages?wait=1&timeoutMs=$timeoutMs"
        val json = postJson(path, body, wait = true)
        val msg = json.optJSONObject("message")
            ?: throw IOException(json.optString("error", "no assistant reply"))
        return parseMessage(msg, sessionId)
            ?: throw IOException("malformed assistant reply")
    }

    private fun turnBody(text: String, agent: String?, thinking: String?): JSONObject {
        val body = JSONObject().put("text", text)
        if (!agent.isNullOrBlank()) body.put("agent", agent)
        if (!thinking.isNullOrBlank()) body.put("thinking", thinking)
        return body
    }

    private fun parseMessages(arr: JSONArray, fallbackSession: String): List<SessionMessage> {
        val out = ArrayList<SessionMessage>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            parseMessage(o, fallbackSession)?.let { out.add(it) }
        }
        return out
    }

    private fun parseMessage(o: JSONObject, fallbackSession: String): SessionMessage? {
        val role = o.optString("role").trim()
        val text = o.optString("text")
        if (role.isEmpty()) return null
        return SessionMessage(
            id = o.optString("id").ifBlank { java.util.UUID.randomUUID().toString() },
            sessionId = o.optString("sessionId").ifBlank { fallbackSession },
            role = role,
            text = text,
            ts = o.optLong("ts", System.currentTimeMillis()),
        )
    }

    private fun getJson(path: String): JSONObject {
        val req = authorized(Request.Builder().url(base + path).get()).build()
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IOException("GET $path → HTTP ${resp.code}: ${body.take(200)}")
            }
            return JSONObject(body.ifBlank { "{}" })
        }
    }

    private fun postJson(path: String, body: JSONObject, wait: Boolean): JSONObject {
        val media = "application/json; charset=utf-8".toMediaType()
        val client = if (wait) waitHttp else http
        val url = if (path.startsWith("http")) path else base + path
        val req = authorized(
            Request.Builder()
                .url(url)
                .post(body.toString().toRequestBody(media)),
        ).build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = runCatching { JSONObject(text.ifBlank { "{}" }) }.getOrElse { JSONObject() }
            if (!resp.isSuccessful) {
                val err = json.optString("error").ifBlank { text.take(200) }
                throw IOException("POST $path → HTTP ${resp.code}: $err")
            }
            return json
        }
    }

    private fun authorized(builder: Request.Builder): Request.Builder {
        val t = token?.trim().orEmpty()
        if (t.isNotEmpty()) builder.header("Authorization", "Bearer $t")
        return builder
    }

    companion object {
        private const val READ_TIMEOUT_SEC = 20L
        private const val CALL_TIMEOUT_SEC = 25L
        private const val WAIT_READ_TIMEOUT_SEC = 130L
        private const val WAIT_CALL_TIMEOUT_SEC = 140L
        const val DEFAULT_WAIT_MS = 120_000L

        /**
         * Soft list for attach/sync. Swallows transport errors so a down node
         * does not crash the poll — but logs auth failures (401/403) so a bad
         * or missing bearer is visible rather than looking like "no sessions".
         */
        fun tryList(denUrl: String, token: String? = null): List<SessionSummary> =
            runCatching { GatewaySessionsClient(denUrl, token).listSessions() }
                .onFailure { err ->
                    val msg = err.message.orEmpty()
                    if (msg.contains("401") || msg.contains("403") ||
                        msg.contains("Unauthorized", ignoreCase = true) ||
                        msg.contains("Forbidden", ignoreCase = true)
                    ) {
                        android.util.Log.w(
                            "GatewaySessions",
                            "tryList auth failure for $denUrl: $msg",
                        )
                    }
                }
                .getOrDefault(emptyList())
    }
}

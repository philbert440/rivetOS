package dev.rivet.app.ui.pages.terminal

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Kotlin client for den-server's terminal surface (`/api/terminal/...` aliases of `/term/...`).
 *
 * Wire protocol (see `services/den-server/src/term/ws.ts` + web `XtermAttach`):
 * - Connect `ws(s)://<den>/api/terminal/ws?id=<ptyId>` (optional `?token=` — WS cannot send headers)
 * - Server → client: JSON hello, binary scrollback, live binary output, JSON `{type:exit}` then close
 * - Client → server: binary keystrokes; JSON `{type:resize,cols,rows}` / `{type:kill}`
 *
 * HTTP spawn/list use the same base URL. Tokenless is the normal LAN-mesh case.
 *
 * Uses a **process-level shared** [OkHttpClient] (connection pool + dispatcher). REST calls use a
 * derived builder with finite read/call timeouts so a hung den cannot infinite-spin the UI;
 * WebSocket keeps `readTimeout(0)` for long-lived streams.
 */
internal class DenTermClient(
    private val denBaseUrl: String,
    private val token: String? = null,
    client: OkHttpClient? = null,
) {
    /** Long-lived WS client (shared pool; infinite read). */
    private val wsHttp: OkHttpClient = client ?: sharedClient()

    /**
     * REST client: same pool/dispatcher as [wsHttp], finite read + call timeout so
     * reachable-but-hung dens fail the connect spinner instead of blocking forever.
     */
    private val restHttp: OkHttpClient =
        wsHttp.newBuilder()
            .readTimeout(HTTP_READ_TIMEOUT_SEC, TimeUnit.SECONDS)
            .callTimeout(HTTP_CALL_TIMEOUT_SEC, TimeUnit.SECONDS)
            .pingInterval(0, TimeUnit.MILLISECONDS) // not needed for short REST
            .build()

    private val base: String = denBaseUrl.trim().trimEnd('/')

    data class SpawnResult(
        val id: String,
        val denSession: String,
        val command: String,
        val pid: Int,
        val createdAt: Long,
    )

    data class PtyInfo(
        val id: String,
        val denSession: String,
        val command: String,
        val state: String,
        val cols: Int,
        val rows: Int,
        val attached: Int,
    )

    data class TermConfig(
        val enabled: Boolean,
        val defaultCommand: String,
        val commands: List<String>,
    )

    fun termConfig(): TermConfig {
        val json = getJson("/api/terminal/config")
        val cmds = mutableListOf<String>()
        val arr = json.optJSONArray("commands") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val id = arr.optJSONObject(i)?.optString("id")?.takeIf { it.isNotBlank() }
            if (id != null) cmds.add(id)
        }
        return TermConfig(
            enabled = json.optBoolean("enabled", true),
            defaultCommand = json.optString("default", "shell"),
            commands = cmds,
        )
    }

    fun termList(): List<PtyInfo> {
        val json = getJson("/api/terminal/list")
        val arr = json.optJSONArray("ptys") ?: JSONArray()
        val out = ArrayList<PtyInfo>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.add(
                PtyInfo(
                    id = o.optString("id"),
                    denSession = o.optString("denSession"),
                    command = o.optString("command"),
                    state = o.optString("state", "running"),
                    cols = o.optInt("cols", 80),
                    rows = o.optInt("rows", 24),
                    attached = o.optInt("attached", 0),
                ),
            )
        }
        return out
    }

    /**
     * Spawn (or spawn-or-get when [session] is set) a roster command on the remote den.
     * [command] is a roster key (`shell`, `grok`, …) — not a shell argv.
     */
    fun termSpawn(
        command: String? = null,
        session: String? = null,
        resume: String? = null,
        cols: Int = 80,
        rows: Int = 24,
    ): SpawnResult {
        val body = JSONObject()
        if (command != null) body.put("command", command)
        if (session != null) body.put("session", session)
        if (resume != null) body.put("resume", resume)
        body.put("cols", cols.coerceIn(20, 500))
        body.put("rows", rows.coerceIn(5, 200))
        val json = postJson("/api/terminal", body)
        if (json.has("error")) {
            throw IOException(json.optString("error", "spawn failed"))
        }
        val id = json.optString("id")
        if (id.isBlank()) throw IOException("spawn returned no pty id")
        return SpawnResult(
            id = id,
            denSession = json.optString("denSession"),
            command = json.optString("command"),
            pid = json.optInt("pid"),
            createdAt = json.optLong("createdAt"),
        )
    }

    fun terminalWsUrl(ptyId: String): String {
        val httpBase = if (base.endsWith("/")) base else "$base/"
        val wsBase = when {
            httpBase.startsWith("https://") -> "wss://" + httpBase.removePrefix("https://")
            httpBase.startsWith("http://") -> "ws://" + httpBase.removePrefix("http://")
            else -> "ws://$httpBase"
        }
        val u = StringBuilder(wsBase.trimEnd('/'))
            .append("/api/terminal/ws?id=")
            .append(java.net.URLEncoder.encode(ptyId, Charsets.UTF_8.name()))
        val t = token?.trim().orEmpty()
        if (t.isNotEmpty()) {
            u.append("&token=").append(java.net.URLEncoder.encode(t, Charsets.UTF_8.name()))
        }
        return u.toString()
    }

    fun connect(
        ptyId: String,
        listener: Listener,
    ): WebSocket {
        val req = Request.Builder().url(terminalWsUrl(ptyId)).build()
        return wsHttp.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                listener.onText(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                listener.onBinary(bytes.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onClosed(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "terminal ws failure: ${t.message}")
                listener.onFailure(t)
            }
        })
    }

    fun sendResize(ws: WebSocket, cols: Int, rows: Int): Boolean {
        val c = cols.coerceIn(20, 500)
        val r = rows.coerceIn(5, 200)
        return ws.send(JSONObject().put("type", "resize").put("cols", c).put("rows", r).toString())
    }

    fun sendBytes(ws: WebSocket, data: ByteArray, offset: Int = 0, count: Int = data.size): Boolean {
        if (count <= 0) return true
        return ws.send(data.toByteString(offset, count))
    }

    interface Listener {
        fun onOpen() {}
        fun onText(text: String)
        fun onBinary(data: ByteArray)
        fun onClosed(code: Int, reason: String) {}
        fun onFailure(error: Throwable)
    }

    private fun getJson(path: String): JSONObject {
        val req = authorized(Request.Builder().url(base + path).get()).build()
        restHttp.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IOException("GET $path → HTTP ${resp.code}: ${body.take(200)}")
            }
            return JSONObject(body.ifBlank { "{}" })
        }
    }

    private fun postJson(path: String, body: JSONObject): JSONObject {
        val media = "application/json; charset=utf-8".toMediaType()
        val req = authorized(
            Request.Builder()
                .url(base + path)
                .post(body.toString().toRequestBody(media)),
        ).build()
        restHttp.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = runCatching { JSONObject(text.ifBlank { "{}" }) }.getOrElse { JSONObject() }
            if (!resp.isSuccessful && !json.has("error")) {
                throw IOException("POST $path → HTTP ${resp.code}: ${text.take(200)}")
            }
            if (!resp.isSuccessful && json.has("error")) {
                throw IOException(json.optString("error", "HTTP ${resp.code}"))
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
        private const val TAG = "DenTermClient"
        private const val HTTP_READ_TIMEOUT_SEC = 15L
        private const val HTTP_CALL_TIMEOUT_SEC = 20L
        private const val CONNECT_TIMEOUT_SEC = 15L

        /**
         * Single process-level client. Shared connection pool + dispatcher across all remote
         * terminal sessions so open/drop/reconnect cycles cannot leak OkHttp thread pools.
         * Do **not** shut this down on session close.
         */
        @Volatile
        private var shared: OkHttpClient? = null

        fun sharedClient(): OkHttpClient {
            shared?.let { return it }
            synchronized(this) {
                shared?.let { return it }
                val c = OkHttpClient.Builder()
                    .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
                    .readTimeout(0, TimeUnit.MILLISECONDS) // WS is long-lived; den pings keep it alive
                    .writeTimeout(30, TimeUnit.SECONDS)
                    .pingInterval(30, TimeUnit.SECONDS)
                    .retryOnConnectionFailure(true)
                    .build()
                shared = c
                return c
            }
        }

        /** @deprecated Use [sharedClient]; kept name for call-site clarity in older drafts. */
        fun defaultClient(): OkHttpClient = sharedClient()

        /**
         * Map an Android local launch argv onto den roster spawn fields.
         * Local proot uses real binaries (`/bin/bash`, `claude`, `grok`); den expects roster keys.
         */
        fun spawnRequestFor(launchCommand: List<String>, conversationId: String?): SpawnRequest {
            val head = launchCommand.firstOrNull().orEmpty()
            val base = head.substringAfterLast('/')
            val resumeIdx = launchCommand.indexOf("--resume")
            val resume = if (resumeIdx >= 0) launchCommand.getOrNull(resumeIdx + 1) else null
            return when {
                base == "bash" || head.endsWith("/bash") || head == "/bin/bash" || head == "/system/bin/sh" ->
                    SpawnRequest(command = "shell")
                base == "claude" || head == "claude" ->
                    SpawnRequest(command = "claude", session = conversationId, resume = resume)
                base == "grok" || head == "grok" ->
                    SpawnRequest(command = "grok", session = conversationId, resume = resume)
                base == "hermes" || head == "hermes" ->
                    SpawnRequest(command = "hermes", session = conversationId, resume = resume)
                base == "shell" ->
                    SpawnRequest(command = "shell")
                else ->
                    // Unknown argv — default shell so drawer "Terminal" still works remotely.
                    SpawnRequest(command = "shell")
            }
        }

        data class SpawnRequest(
            val command: String? = null,
            val session: String? = null,
            val resume: String? = null,
        )
    }
}

package dev.rivet.app.ui.pages.terminal

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Den-server harness session surface (`/api/terminal/harness-sessions…`).
 *
 * Node-local conversation list + transcript for the active remote den — the
 * same source RivetHub web uses so native UI stays in sync with chat/terminal.
 */
class DenHarnessClient(
    private val denBaseUrl: String,
    private val token: String? = null,
    client: OkHttpClient? = null,
) {
    private val http: OkHttpClient =
        (client ?: DenTermClient.sharedClient()).newBuilder()
            .readTimeout(20, TimeUnit.SECONDS)
            .callTimeout(25, TimeUnit.SECONDS)
            .build()

    private val base: String = denBaseUrl.trim().trimEnd('/')

    data class Session(
        val id: String,
        val command: String,
        val title: String,
        val updatedAt: Long,
    )

    data class Turn(
        val role: String,
        val text: String,
    )

    data class Transcript(
        val id: String,
        val command: String,
        val turns: List<Turn>,
    )

    fun listSessions(limit: Int = 100): List<Session> {
        val json = getJson("/api/terminal/harness-sessions?limit=${limit.coerceIn(1, 500)}")
        val arr = json.optJSONArray("sessions") ?: JSONArray()
        val out = ArrayList<Session>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("id").trim()
            if (id.isEmpty()) continue
            out.add(
                Session(
                    id = id,
                    command = o.optString("command", "").ifBlank { "shell" },
                    title = o.optString("title", "").ifBlank { id.take(8) },
                    updatedAt = o.optLong("updatedAt", 0L),
                ),
            )
        }
        return out
    }

    fun transcript(sessionId: String): Transcript {
        val enc = java.net.URLEncoder.encode(sessionId, Charsets.UTF_8.name())
        val json = getJson("/api/terminal/harness-sessions/$enc/transcript")
        val arr = json.optJSONArray("turns") ?: JSONArray()
        val turns = ArrayList<Turn>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val role = o.optString("role", "user")
            val text = o.optString("text", "")
            if (text.isBlank() && role != "assistant") continue
            turns.add(Turn(role = role, text = text))
        }
        return Transcript(
            id = json.optString("id", sessionId),
            command = json.optString("command", ""),
            turns = turns,
        )
    }

    private fun getJson(path: String): JSONObject {
        val builder = Request.Builder().url(base + path).get()
        val t = token?.trim().orEmpty()
        if (t.isNotEmpty()) builder.header("Authorization", "Bearer $t")
        http.newCall(builder.build()).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IOException("GET $path → HTTP ${resp.code}: ${body.take(200)}")
            }
            return JSONObject(body.ifBlank { "{}" })
        }
    }

    companion object {
        private const val TAG = "DenHarnessClient"

        fun tryList(denUrl: String, token: String? = null, limit: Int = 100): List<Session> =
            runCatching { DenHarnessClient(denUrl, token).listSessions(limit) }
                .onFailure { Log.w(TAG, "listSessions failed: ${it.message}") }
                .getOrDefault(emptyList())

        fun tryTranscript(denUrl: String, sessionId: String, token: String? = null): Transcript? =
            runCatching { DenHarnessClient(denUrl, token).transcript(sessionId) }
                .onFailure { Log.w(TAG, "transcript($sessionId) failed: ${it.message}") }
                .getOrNull()
    }
}

package dev.rivet.app.data.harness

import dev.rivet.app.ui.pages.terminal.DenTermClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Kotlin client for the node harness control plane.
 *
 * `/api/harnesses` for the driver registry and its capability flags,
 * `/api/harness-sessions/<enc>` for one session, where `enc` is the unpadded
 * base64url of the canonical SessionId ([HarnessSessionIds.encodeSegment]).
 * Distinct from the legacy `/api/terminal/harness-sessions` scan that
 * `DenHarnessClient` reads: this family speaks canonical SessionIds, honors
 * capability flags, and its live stream is an at-most-once tail — after any
 * drop the client re-subscribes AND hard-resyncs from the transcript. Never
 * assume replay.
 *
 * WS resources ride the query string because den's upgrade mounts are matched
 * by exact path. The bearer does not: den reads `Authorization` on an upgrade
 * request just as it does on a GET, and only offers `?token=` because a
 * browser's `WebSocket` constructor cannot set headers. OkHttp can, so the
 * credential stays on the handshake and out of every URL.
 *
 * Blocking by design, like [DenHarnessClient] — callers are already on
 * `Dispatchers.IO`.
 *
 * Contract: docs/plans/harness-control-plane.md, "As built (node control plane)".
 */
class HarnessControlPlaneClient(
    denBaseUrl: String,
    private val token: String? = null,
    client: OkHttpClient? = null,
) {
    private val shared: OkHttpClient = client ?: DenTermClient.sharedClient()

    /** Finite timeouts for REST; the WS client keeps the shared long-lived one. */
    private val http: OkHttpClient = shared.newBuilder()
        .readTimeout(20, TimeUnit.SECONDS)
        .callTimeout(25, TimeUnit.SECONDS)
        .build()

    val urls = HarnessUrls(denBaseUrl)

    // -- registry --------------------------------------------------------------

    /** Registered drivers and their capability flags. */
    fun harnesses(): List<HarnessDescriptor> =
        HarnessDescriptor.listFrom(getJson(urls.harnesses()))

    /** One driver's capability sheet. */
    fun harnessCapabilities(harnessId: String): HarnessDescriptor? =
        HarnessDescriptor.from(getJson(urls.harness(harnessId)))

    /** One driver's sessions — canonical ids only (superseded ids never appear). */
    fun sessions(harnessId: String): List<HarnessSessionSummary> =
        HarnessSessionSummary.listFrom(getJson(urls.harnessSessions(harnessId)))

    // -- one session -----------------------------------------------------------

    fun session(sessionId: String): HarnessSessionSummary? =
        HarnessSessionSummary.from(getJson(urls.session(sessionId)))

    /** Attach to an existing session (spawn-or-get on the node). */
    fun resume(sessionId: String): HarnessSessionSummary? =
        HarnessSessionSummary.from(postJson(urls.resume(sessionId), null))

    /**
     * Send a user turn. Rejects with `turn_in_flight` (409) while a turn is
     * running — v1 drivers never silently queue, so the caller owns the queue.
     */
    fun sendTurn(sessionId: String, text: String, attachments: List<StagedAttachment> = emptyList()) {
        val body = JSONObject().put("text", text)
        if (attachments.isNotEmpty()) {
            val arr = org.json.JSONArray()
            attachments.forEach { arr.put(it.toJson()) }
            body.put("attachments", arr)
        }
        postJson(urls.turns(sessionId), body)
    }

    /** Cancel the in-flight turn. Idempotent; 501 when the driver has none. */
    fun interrupt(sessionId: String) {
        postJson(urls.interrupt(sessionId), null)
    }

    /** Answer an `approval-request`. 501 when the driver reports approvals:false. */
    fun resolveApproval(sessionId: String, requestId: String, decision: ApprovalDecision) {
        postJson(
            urls.approval(sessionId, requestId),
            JSONObject().put("decision", decision.wire),
        )
    }

    /** Hard-resync source: the session's committed transcript. */
    fun transcript(sessionId: String): HarnessTranscript =
        HarnessTranscript.from(getJson(urls.transcript(sessionId)))

    /**
     * Stage a client attachment so a turn can carry a node-resolvable path.
     * Raw body, metadata in the query string — den has no multipart parser.
     */
    fun upload(name: String, mime: String?, bytes: ByteArray): StagedAttachment {
        val body = bytes.toRequestBody(
            (mime ?: "application/octet-stream").toMediaType(),
        )
        val json = execute(
            authorized(Request.Builder().url(urls.upload(name, mime)).post(body)).build(),
            "POST /api/uploads",
        )
        return StagedAttachment(
            mime = json.optString("mime", mime ?: "application/octet-stream"),
            pathOrUri = json.optString("uri", ""),
            name = json.optStringOrNull("name"),
        )
    }

    // -- live tails ------------------------------------------------------------

    /**
     * Tail one session's events. Reconnects with backoff; every `onOpen` is a
     * FRESH attach the caller must follow with a transcript hard-resync,
     * because the tail carries nothing that happened during the gap.
     */
    fun watchSession(sessionId: String, listener: HarnessStreamListener): HarnessSubscription =
        ReconnectingSocket(
            url = { urls.sessionWs(sessionId) },
            listener = listener,
            connectSocket = ReconnectingSocket.over(shared, token),
        ).start()

    /** Driver-level registry stream — `session-created` / `session-updated`. */
    fun watchHarnesses(harnessId: String?, listener: HarnessStreamListener): HarnessSubscription =
        ReconnectingSocket(
            url = { urls.harnessesWs(harnessId) },
            listener = listener,
            connectSocket = ReconnectingSocket.over(shared, token),
        ).start()

    // -- plumbing --------------------------------------------------------------

    private fun getJson(url: String): JSONObject =
        execute(authorized(Request.Builder().url(url).get()).build(), url)

    private fun postJson(url: String, body: JSONObject?): JSONObject {
        val payload = (body?.toString() ?: "{}").toRequestBody(JSON_MEDIA)
        return execute(authorized(Request.Builder().url(url).post(payload)).build(), url)
    }

    private fun authorized(builder: Request.Builder): Request.Builder {
        val t = token?.trim().orEmpty()
        if (t.isNotEmpty()) builder.header("Authorization", "Bearer $t")
        return builder
    }

    private fun execute(request: Request, what: String): JSONObject {
        val response: Response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            // One error surface: a node that is down and a node that says no
            // both arrive as HarnessHttpException, status 0 for unreachable.
            throw HarnessHttpException(0, null, "node unreachable: ${e.message}", retryable = true)
        }
        response.use { resp ->
            val raw = resp.body?.string().orEmpty()
            val json = runCatching { JSONObject(raw.ifBlank { "{}" }) }.getOrNull()
            if (!resp.isSuccessful) {
                throw HarnessHttpException(
                    status = resp.code,
                    code = json?.optStringOrNull("code"),
                    message = json?.optStringOrNull("error") ?: "harness ${resp.code} on $what",
                    retryable = json?.let { if (it.has("retryable")) it.optBoolean("retryable") else null },
                )
            }
            return json ?: throw HarnessHttpException(
                0,
                null,
                "harness returned a non-JSON body on $what",
                retryable = true,
            )
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}

/** A node-resolvable attachment, as returned by `POST /api/uploads`. */
data class StagedAttachment(
    val mime: String,
    val pathOrUri: String,
    val name: String? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("mime", mime)
        .put("pathOrUri", pathOrUri)
        .also { if (name != null) it.put("name", name) }
}

/**
 * Non-2xx (or unreachable) control-plane reply, carrying the typed wire `code`
 * so callers can branch on the contract's vocabulary rather than on prose.
 * Status 0 means the request never got an answer.
 */
class HarnessHttpException(
    val status: Int,
    val code: String?,
    override val message: String,
    val retryable: Boolean?,
) : IOException(message)

/**
 * Everything one bound chat thread needs from a node — the binder's test seam.
 * A superset of [HarnessAttachGateway]: attaching reads and tails, driving also
 * sends and interrupts.
 */
interface HarnessSessionGateway : HarnessAttachGateway {
    fun sendTurn(sessionId: String, text: String)
    fun interrupt(sessionId: String)
}

/** [HarnessSessionGateway] over a real client. */
class ClientSessionGateway(
    private val client: HarnessControlPlaneClient,
) : HarnessSessionGateway {
    override fun transcript(sessionId: String): HarnessTranscript = client.transcript(sessionId)

    override fun watchSession(
        sessionId: String,
        listener: HarnessStreamListener,
    ): HarnessSubscription = client.watchSession(sessionId, listener)

    override fun sendTurn(sessionId: String, text: String) = client.sendTurn(sessionId, text)

    override fun interrupt(sessionId: String) = client.interrupt(sessionId)
}

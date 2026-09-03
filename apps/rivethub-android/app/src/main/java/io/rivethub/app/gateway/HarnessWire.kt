package io.rivethub.app.gateway

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Base64

/** Fixed product tokens — left half of a canonical SessionId. */
val HARNESS_IDS: Set<String> = setOf(
    "claude-code",
    "grok-build",
    "kimi-code",
    "hermes",
    "deepseek-harness",
)

/** HTTP 409 `turn_in_flight` — the driver is mid-turn; the caller queues and retries. */
class TurnInFlight(message: String = "turn_in_flight") : GatewayException(409, message)

@Serializable
data class EffortOption(
    val id: String,
    val label: String,
    val default: Boolean = false,
)

@Serializable
data class ModelOption(
    val id: String,
    val label: String,
    val default: Boolean = false,
    val efforts: List<EffortOption>? = null,
)

@Serializable
data class HarnessCapabilities(
    val interrupt: Boolean = false,
    val resume: Boolean = false,
    val approvals: Boolean = false,
    val liveStream: Boolean = false,
    val listSessions: Boolean = false,
    val models: List<ModelOption>? = null,
    val efforts: List<EffortOption>? = null,
    val modelFlag: String? = null,
    val effortFlag: String? = null,
)

@Serializable
data class HarnessDescriptor(
    val harnessId: String,
    val capabilities: HarnessCapabilities = HarnessCapabilities(),
)

@Serializable
data class HarnessesResponse(val harnesses: List<HarnessDescriptor> = emptyList())

@Serializable
data class HarnessSessionSummary(
    val sessionId: String,
    val harnessId: String,
    val title: String? = null,
    val cwd: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
    val status: String = "idle",
    val supersedes: String? = null,
    val model: String? = null,
    /**
     * Present when the request id was superseded; [sessionId] is already the
     * canonical. A request under a bare id answers with the canonical — the
     * adoption signal M3b looks for.
     */
    val redirectedTo: String? = null,
)

@Serializable
data class HarnessSessionListResponse(val sessions: List<HarnessSessionSummary> = emptyList())

/** On-disk scan row from GET /api/terminal/harness-sessions (epoch-ms updatedAt). */
@Serializable
data class LegacyHarnessSession(
    val id: String,
    val command: String = "",
    val title: String = "",
    val updatedAt: Long = 0,
)

@Serializable
data class LegacyHarnessSessionsResponse(val sessions: List<LegacyHarnessSession> = emptyList())

/**
 * Control-plane turn body. Never carries an attachments field — every PTY
 * driver rejects UserTurn.attachments with capability_unsupported. Stage
 * files via POST /api/uploads and inject `[attached: uri]` lines in [text].
 */
@Serializable
data class UserTurn(
    val text: String,
    val systemPrompt: String? = null,
)

@Serializable
data class HarnessTurnAccepted(
    val ok: Boolean = true,
    val sessionId: String = "",
    /**
     * Canonical id when the request used a superseded or bare id. The 202's
     * [sessionId] already carries the canonical, so this is the same adoption
     * signal — modelled so M3b can read it without rediscovering ignoreUnknownKeys.
     */
    val redirectedTo: String? = null,
)

/** One tool invocation recorded on an assistant transcript turn. */
@Serializable
data class HarnessTranscriptTool(
    val name: String,
    val status: String = "running",
    val args: JsonObject? = null,
)

@Serializable
data class HarnessTranscriptTurn(
    val role: String,
    val text: String = "",
    val thinking: String? = null,
    val model: String? = null,
    val tools: List<HarnessTranscriptTool>? = null,
    val usage: MessageUsage? = null,
)

@Serializable
data class HarnessSessionTranscriptResponse(
    val sessionId: String = "",
    val harnessId: String = "",
    val turns: List<HarnessTranscriptTurn> = emptyList(),
    /**
     * Canonical id when the request used a superseded id. [sessionId] is
     * already the canonical; this is the same adoption signal as the 202.
     */
    val redirectedTo: String? = null,
)

/**
 * POST /api/uploads 201 body. [expiresAt] is an ISO-8601 string when the den
 * set a TTL, and absent when ttlMs is 0 — never a Long (the desktop type at
 * gateway-api.ts:889 is wrong; the server writes `new Date(...).toISOString()`).
 */
@Serializable
data class StagedUploadResponse(
    val uri: String,
    val name: String = "",
    val mime: String = "",
    val size: Long = 0,
    val expiresAt: String? = null,
)

/**
 * Live-tail events. Parsed by [parseHarnessEvent], which tolerates hyphen,
 * underscore, and a few den-bridge aliases (`assistant_response`, `text`).
 */
sealed class HarnessEvent {
    data class AssistantDelta(val sessionId: String, val text: String, val turnId: String? = null) : HarnessEvent()
    data class ReasoningDelta(val sessionId: String, val text: String, val turnId: String? = null) : HarnessEvent()
    data class ToolUse(
        val sessionId: String,
        val toolCallId: String,
        val name: String,
        val input: JsonElement? = null,
        val turnId: String? = null,
    ) : HarnessEvent()
    data class ToolResult(
        val sessionId: String,
        val toolCallId: String,
        val name: String,
        val output: JsonElement? = null,
        val isError: Boolean = false,
        val turnId: String? = null,
    ) : HarnessEvent()
    data class TurnComplete(
        val sessionId: String,
        val turnId: String? = null,
        val stopReason: String? = null,
    ) : HarnessEvent()
    data class SessionCreated(
        val sessionId: String,
        val summary: HarnessSessionSummary,
        val supersedes: String? = null,
    ) : HarnessEvent()
    data class SessionUpdated(
        val sessionId: String,
        val status: String,
        val previousSessionId: String? = null,
        val supersedes: String? = null,
    ) : HarnessEvent()
    data class Error(
        val sessionId: String,
        val code: String,
        val message: String,
        val retryable: Boolean? = null,
    ) : HarnessEvent()
    /** Den-level registry frame — not session-scoped. Full sheet replace. */
    data class CapabilitiesChanged(
        val harnessId: String,
        val capabilities: HarnessCapabilities,
        val changed: JsonObject? = null,
        val reason: String = "",
    ) : HarnessEvent()
    data class Unknown(val type: String, val raw: JsonObject) : HarnessEvent()
}

/**
 * Attach-failure codes: the den sends the error frame and closes. Reconnecting
 * loops forever. `forbidden` is the tenancy refusal (routes.ts) — a third
 * fatal the desktop set does not list.
 */
val FATAL_EVENT_CODES: Set<String> = setOf(
    "invalid_session_id",
    "capability_unsupported",
    "forbidden",
)

fun isFatalHarnessEvent(event: HarnessEvent): Boolean =
    event is HarnessEvent.Error && event.code in FATAL_EVENT_CODES

/** Transcript GET statuses that mean the session is gone, not transient. */
val FATAL_TRANSCRIPT_STATUS: Set<Int> = setOf(400, 403, 404, 410, 501)

fun isFatalTranscriptError(err: Throwable): Boolean =
    err is GatewayException && err.status in FATAL_TRANSCRIPT_STATUS

/**
 * Unpadded base64url of the UTF-8 canonical id. Canonical ids contain `:`,
 * so they cannot ride a path segment raw.
 */
fun sessionKeyEnc(canonicalId: String): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(canonicalId.toByteArray(Charsets.UTF_8))

fun sessionKeyDec(enc: String): String =
    String(Base64.getUrlDecoder().decode(enc), Charsets.UTF_8)

/**
 * Native half of a canonical `<harness-id>:<native>` id. Split on the first
 * colon only (native ids may contain `:`). Null when the prefix is not a
 * known harness token — a malformed id is the node's bug, not a row.
 */
fun nativeIdOf(sessionId: String): String? {
    if (sessionId != sessionId.trim()) return null
    val i = sessionId.indexOf(':')
    if (i <= 0 || i == sessionId.length - 1) return null
    val harnessId = sessionId.substring(0, i)
    if (harnessId !in HARNESS_IDS) return null
    return sessionId.substring(i + 1)
}

fun denRoomKey(chatKey: String): String = nativeIdOf(chatKey) ?: chatKey

fun parseHarnessEvent(text: String): HarnessEvent? {
    val el = runCatching { wireJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
    return parseHarnessEvent(el)
}

fun parseHarnessEvent(el: JsonObject): HarnessEvent {
    val rawType = el.str("type") ?: return HarnessEvent.Unknown("", el)
    val type = normalizeEventType(rawType)
    val sessionId = el.str("sessionId") ?: el.str("session") ?: ""
    val turnId = el.str("turnId")
    val text = el.str("text") ?: el.str("content") ?: ""
    return when (type) {
        "turn-complete" -> HarnessEvent.TurnComplete(sessionId, turnId, el.str("stopReason"))
        "assistant-delta", "assistant-response", "text" ->
            HarnessEvent.AssistantDelta(sessionId, text, turnId)
        "reasoning-delta", "reasoning" ->
            HarnessEvent.ReasoningDelta(sessionId, text, turnId)
        "tool-use" -> HarnessEvent.ToolUse(
            sessionId = sessionId,
            toolCallId = el.str("toolCallId") ?: "",
            name = el.str("name") ?: "",
            input = el["input"] ?: el["args"],
            turnId = turnId,
        )
        "tool-result" -> HarnessEvent.ToolResult(
            sessionId = sessionId,
            toolCallId = el.str("toolCallId") ?: "",
            name = el.str("name") ?: "",
            output = el["output"],
            isError = el["isError"]?.jsonPrimitive?.booleanOrNull == true,
            turnId = turnId,
        )
        "session-created" -> {
            val summaryEl = el["summary"]
            val summary = summaryEl?.let {
                runCatching { wireJson.decodeFromJsonElement(HarnessSessionSummary.serializer(), it) }.getOrNull()
            }
            if (summary == null) HarnessEvent.Unknown(rawType, el)
            else HarnessEvent.SessionCreated(sessionId.ifBlank { summary.sessionId }, summary, el.str("supersedes"))
        }
        "session-updated" -> HarnessEvent.SessionUpdated(
            sessionId = sessionId,
            status = el.str("status") ?: "idle",
            previousSessionId = el.str("previousSessionId"),
            supersedes = el.str("supersedes"),
        )
        "error" -> HarnessEvent.Error(
            sessionId = sessionId,
            code = el.str("code") ?: "",
            message = el.str("message") ?: "",
            retryable = el["retryable"]?.jsonPrimitive?.booleanOrNull,
        )
        "harness-capabilities" -> {
            val caps = el["capabilities"]?.let {
                runCatching { wireJson.decodeFromJsonElement(HarnessCapabilities.serializer(), it) }.getOrNull()
            } ?: HarnessCapabilities()
            HarnessEvent.CapabilitiesChanged(
                harnessId = el.str("harnessId") ?: "",
                capabilities = caps,
                changed = el["changed"] as? JsonObject,
                reason = el.str("reason") ?: "",
            )
        }
        else -> HarnessEvent.Unknown(rawType, el)
    }
}

fun isTurnInFlight(err: Throwable): Boolean = err is TurnInFlight

fun isTurnInFlightStatus(status: Int, bodyCode: String?): Boolean =
    status == 409 && bodyCode == "turn_in_flight"

private fun normalizeEventType(type: String): String = type.lowercase().replace('_', '-')

private fun JsonObject.str(key: String): String? =
    runCatching { this[key]?.jsonPrimitive?.contentOrNull }.getOrNull()

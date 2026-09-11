package io.rivethub.app.gateway

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.Base64

/** Fixed product tokens — left half of a canonical SessionId. */
val HARNESS_IDS: Set<String> = setOf(
    "claude-code",
    "grok-build",
    "kimi-code",
    "opencode",
    "hermes",
    "deepseek-harness",
    "codex",
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
    val inputModalities: List<String>? = null,
)

@Serializable
data class HarnessCapabilities(
    val interrupt: Boolean = false,
    val resume: Boolean = false,
    val approvals: Boolean = false,
    val liveStream: Boolean = false,
    val listSessions: Boolean = false,
    /** Native per-turn model/effort settings (not CLI spawn flags). */
    val turnOptions: Boolean = false,
    /** Structured staged image inputs. */
    val imageAttachments: Boolean = false,
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
    val effort: String? = null,
    /** Session-specific transport; a driver can also serve older PTY sessions. */
    val transport: String? = null,
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
 * Control-plane turn body. PTY drivers reject [attachments] with
 * capability_unsupported — those sessions still stage via POST /api/uploads
 * and inject `[attached: uri]` lines in [text]. Protocol-owned Codex
 * sessions send structured [attachments] plus optional [model]/[effort]
 * when the sheet advertises turnOptions / imageAttachments.
 */
@Serializable
data class UserTurnAttachment(
    val mime: String,
    val pathOrUri: String,
    val name: String? = null,
)

@Serializable
data class UserTurn(
    val text: String,
    val systemPrompt: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val attachments: List<UserTurnAttachment>? = null,
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
    val id: String? = null,
    val input: JsonElement? = null,
    val resultText: String? = null,
)

@Serializable
data class HarnessTranscriptTurn(
    val role: String,
    val text: String = "",
    val thinking: String? = null,
    val model: String? = null,
    val tools: List<HarnessTranscriptTool>? = null,
    val usage: MessageUsage? = null,
    val stopReason: String? = null,
    val lastBlock: String? = null,
    val complete: Boolean? = null,
    /** Synthetic "Conversation compacted" assistant turn — available on the wire, ignored for rendering. */
    val compact: Boolean? = null,
)

@Serializable
data class HarnessAskOption(
    val label: String,
    val description: String? = null,
)

@Serializable
data class HarnessAskQuestion(
    val question: String? = null,
    val header: String? = null,
    val multiSelect: Boolean = false,
    val options: List<HarnessAskOption> = emptyList(),
    /**
     * Text-entry question (Codex `options: null`, or an explicit marker).
     * Distinct from an empty option list on a herdr picker, which stays
     * terminal-only.
     */
    val freeText: Boolean = false,
)

@Serializable
data class HarnessPromptAnswer(
    val question: Int,
    val labels: List<String> = emptyList(),
    val other: String? = null,
)

@Serializable
data class HarnessPromptAnswersBody(val answers: List<HarnessPromptAnswer>)

@Serializable
data class HarnessApprovalDecisionBody(val decision: String)

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
    /** Real max window, tokens (context-bar contract; null until the den reports it). */
    val contextWindow: Int? = null,
    /** Forced-compaction threshold — the context bar's 100%. */
    val compactAt: Int? = null,
    /** "spawn" | "observed" | "default". */
    val contextSource: String? = null,
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
        val updatedAt: String? = null,
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
    data class Transcript(
        val sessionId: String,
        val rev: Int,
        val from: Int,
        val total: Int,
        val turns: List<HarnessTranscriptTurn>,
        val command: String,
        val truncatedBefore: Boolean = false,
        val contextWindow: Int? = null,
        val compactAt: Int? = null,
        val contextSource: String? = null,
    ) : HarnessEvent()
    data class Status(
        val sessionId: String,
        val status: String,
        val since: Long,
        val source: String? = null,
        val phase: String? = null,
        val toolName: String? = null,
        val toolCallId: String? = null,
        val promptId: String? = null,
    ) : HarnessEvent()
    data class Prompt(
        val sessionId: String,
        val promptId: String,
        val toolName: String,
        val questions: List<HarnessAskQuestion>,
        val resolved: Boolean,
        val answerText: String? = null,
        /** Screen-read picker (herdr): `questions` has the current item; this says where it sits. */
        val screen: PromptScreen? = null,
    ) : HarnessEvent()
    data class ApprovalRequest(
        val sessionId: String,
        val requestId: String,
        val name: String,
        val input: JsonObject? = null,
        val reason: String? = null,
        val options: List<String>? = null,
    ) : HarnessEvent()
    data class ApprovalResolved(
        val sessionId: String,
        val requestId: String,
        val decision: String,
    ) : HarnessEvent()
    data class Unknown(val type: String, val raw: JsonObject) : HarnessEvent()
}

/** `HarnessPromptEvent.screen` — 0-based [current] of [total] herdr picker questions. */
data class PromptScreen(val current: Int, val total: Int)

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
            updatedAt = el.str("updatedAt"),
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
        "transcript" -> HarnessEvent.Transcript(
            sessionId = sessionId,
            rev = el.int("rev") ?: 0,
            from = el.int("from") ?: 0,
            total = el.int("total") ?: 0,
            turns = parseTurns(el["turns"]),
            command = el.str("command") ?: "",
            truncatedBefore = el["truncatedBefore"]?.jsonPrimitive?.booleanOrNull == true,
            contextWindow = el.int("contextWindow"),
            compactAt = el.int("compactAt"),
            contextSource = el.str("contextSource"),
        )
        "status" -> {
            val tool = el["tool"] as? JsonObject
            HarnessEvent.Status(
                sessionId = sessionId,
                status = el.str("status") ?: "idle",
                since = el.long("since") ?: 0L,
                source = el.str("source"),
                phase = el.str("phase"),
                toolName = tool?.str("name") ?: el.str("tool"),
                toolCallId = tool?.str("toolCallId"),
                promptId = el.str("promptId"),
            )
        }
        "prompt" -> {
            val resolvedEl = el["resolved"]
            val resolvedObj = resolvedEl as? JsonObject
            val resolved = resolvedEl != null && resolvedEl !is JsonNull
            HarnessEvent.Prompt(
                sessionId = sessionId,
                promptId = el.str("promptId") ?: "",
                toolName = el.str("toolName") ?: "",
                questions = parseAskQuestions(el["questions"]),
                resolved = resolved,
                answerText = resolvedObj?.str("answerText"),
                screen = parsePromptScreen(el["screen"]),
            )
        }
        "approval-request" -> HarnessEvent.ApprovalRequest(
            sessionId = sessionId,
            requestId = el.str("requestId") ?: "",
            name = el.str("name") ?: "",
            input = el["input"] as? JsonObject,
            reason = el.str("reason"),
            options = parseStringList(el["options"]),
        )
        "approval-resolved" -> HarnessEvent.ApprovalResolved(
            sessionId = sessionId,
            requestId = el.str("requestId") ?: "",
            decision = el.str("decision") ?: "",
        )
        else -> HarnessEvent.Unknown(rawType, el)
    }
}

fun isTurnInFlight(err: Throwable): Boolean = err is TurnInFlight

fun isTurnInFlightStatus(status: Int, bodyCode: String?): Boolean =
    status == 409 && bodyCode == "turn_in_flight"

private fun normalizeEventType(type: String): String = type.lowercase().replace('_', '-')

private fun JsonObject.str(key: String): String? =
    runCatching { this[key]?.jsonPrimitive?.contentOrNull }.getOrNull()

private fun JsonObject.int(key: String): Int? =
    runCatching { this[key]?.jsonPrimitive?.intOrNull }.getOrNull()
        ?: runCatching { this[key]?.jsonPrimitive?.contentOrNull?.toInt() }.getOrNull()

private fun JsonObject.long(key: String): Long? =
    runCatching { this[key]?.jsonPrimitive?.longOrNull }.getOrNull()
        ?: runCatching { this[key]?.jsonPrimitive?.contentOrNull?.toLong() }.getOrNull()

private fun parseTurns(el: JsonElement?): List<HarnessTranscriptTurn> {
    val arr = el as? JsonArray ?: return emptyList()
    return arr.mapNotNull {
        runCatching { wireJson.decodeFromJsonElement(HarnessTranscriptTurn.serializer(), it) }.getOrNull()
    }
}

private fun parsePromptScreen(el: JsonElement?): PromptScreen? {
    val obj = el as? JsonObject ?: return null
    val current = obj.int("current") ?: return null
    val total = obj.int("total") ?: return null
    return PromptScreen(current, total)
}

private fun parseAskQuestions(el: JsonElement?): List<HarnessAskQuestion> {
    val arr = el as? JsonArray ?: return emptyList()
    return arr.mapNotNull { item ->
        val obj = item as? JsonObject ?: return@mapNotNull null
        val optionsEl = when (val o = obj["options"]) {
            null, is JsonNull -> obj["choices"]
            else -> o
        }
        val optionsMissing = optionsEl == null || optionsEl is JsonNull
        val freeText = obj["freeText"]?.jsonPrimitive?.booleanOrNull == true || optionsMissing
        HarnessAskQuestion(
            question = obj.str("question"),
            header = obj.str("header"),
            multiSelect = obj["multiSelect"]?.jsonPrimitive?.booleanOrNull == true,
            options = parseAskOptions(optionsEl),
            freeText = freeText,
        )
    }
}

private fun parseAskOptions(el: JsonElement?): List<HarnessAskOption> {
    val arr = el as? JsonArray ?: return emptyList()
    return arr.mapNotNull { item ->
        when (item) {
            is kotlinx.serialization.json.JsonPrimitive ->
                item.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }?.let { HarnessAskOption(it) }
            is JsonObject -> {
                val label = item.str("label") ?: item.str("value") ?: item.str("text") ?: return@mapNotNull null
                HarnessAskOption(label, item.str("description"))
            }
            else -> null
        }
    }
}

private fun parseStringList(el: JsonElement?): List<String>? {
    val arr = el as? JsonArray ?: return null
    return arr.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }
}

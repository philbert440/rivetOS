package dev.rivet.app.data.harness

import org.json.JSONArray
import org.json.JSONObject

/**
 * Wire shapes of the harness control plane (`/api/harnesses`,
 * `/api/harness-sessions`) and their org.json readers.
 *
 * Parsing lives here rather than in the client so it stays free of OkHttp and
 * `android.util.Log` — the unit-test classpath carries a real org.json, but
 * android.jar's `Log` throws.
 *
 * Kotlin twin of `packages/types/src/harness.ts` +
 * the harness half of `packages/types/src/gateway-api.ts`.
 */

/**
 * Which optional driver methods are actually implemented. A method whose flag
 * is false rejects with `capability_unsupported` (HTTP 501), so UIs gate the
 * affordance rather than showing it and failing.
 */
data class HarnessCapabilities(
    val interrupt: Boolean = false,
    val resume: Boolean = false,
    val approvals: Boolean = false,
    val liveStream: Boolean = false,
    val listSessions: Boolean = false,
) {
    companion object {
        fun from(json: JSONObject?): HarnessCapabilities {
            if (json == null) return HarnessCapabilities()
            return HarnessCapabilities(
                interrupt = json.optBoolean("interrupt", false),
                resume = json.optBoolean("resume", false),
                approvals = json.optBoolean("approvals", false),
                liveStream = json.optBoolean("liveStream", false),
                listSessions = json.optBoolean("listSessions", false),
            )
        }
    }
}

/** One registered driver: `GET /api/harnesses` row. */
data class HarnessDescriptor(
    val harnessId: String,
    val capabilities: HarnessCapabilities,
) {
    companion object {
        fun from(json: JSONObject): HarnessDescriptor? {
            val id = json.optString("harnessId").trim()
            if (id.isEmpty()) return null
            return HarnessDescriptor(id, HarnessCapabilities.from(json.optJSONObject("capabilities")))
        }

        /** Rows of `{ harnesses: [...] }`; unreadable rows are dropped. */
        fun listFrom(json: JSONObject): List<HarnessDescriptor> =
            json.optJSONArray("harnesses").objects().mapNotNull { from(it) }
    }
}

/** `idle` = session alive, no turn in flight. */
enum class HarnessStatus {
    ACTIVE, IDLE, ENDED, ERROR;

    companion object {
        fun from(value: String?): HarnessStatus = when (value?.lowercase()) {
            "active" -> ACTIVE
            "ended" -> ENDED
            "error" -> ERROR
            else -> IDLE
        }
    }
}

/** A control-plane session row — canonical ids only. */
data class HarnessSessionSummary(
    val sessionId: String,
    val harnessId: String,
    val title: String?,
    val cwd: String?,
    val createdAt: String?,
    val updatedAt: String?,
    val status: HarnessStatus,
) {
    /** Bare native id — the den join key Android files conversations under. */
    val nativeSessionId: String? get() = HarnessSessionIds.nativeIdOf(sessionId)

    companion object {
        fun from(json: JSONObject): HarnessSessionSummary? {
            val sessionId = json.optString("sessionId").trim()
            if (sessionId.isEmpty()) return null
            val harnessId = json.optString("harnessId").trim().ifEmpty {
                HarnessSessionIds.parseOrNull(sessionId)?.harnessId ?: return null
            }
            return HarnessSessionSummary(
                sessionId = sessionId,
                harnessId = harnessId,
                title = json.optStringOrNull("title"),
                cwd = json.optStringOrNull("cwd"),
                createdAt = json.optStringOrNull("createdAt"),
                updatedAt = json.optStringOrNull("updatedAt"),
                status = HarnessStatus.from(json.optStringOrNull("status")),
            )
        }

        fun listFrom(json: JSONObject): List<HarnessSessionSummary> =
            json.optJSONArray("sessions").objects().mapNotNull { from(it) }
    }
}

/** One tool invocation recorded on an assistant transcript turn. */
data class HarnessTranscriptTool(
    val name: String,
    val status: String,
) {
    companion object {
        fun from(json: JSONObject): HarnessTranscriptTool? {
            val name = json.optString("name").trim()
            if (name.isEmpty()) return null
            return HarnessTranscriptTool(name, json.optString("status", "done"))
        }
    }
}

/** One committed turn from the hard-resync source. */
data class HarnessTranscriptTurn(
    val role: String,
    val text: String,
    val thinking: String? = null,
    val tools: List<HarnessTranscriptTool> = emptyList(),
    val model: String? = null,
) {
    companion object {
        fun from(json: JSONObject): HarnessTranscriptTurn? {
            val role = json.optString("role").lowercase()
            if (role != "user" && role != "assistant") return null
            return HarnessTranscriptTurn(
                role = role,
                text = json.optString("text", ""),
                thinking = json.optStringOrNull("thinking"),
                tools = json.optJSONArray("tools").objects().mapNotNull { HarnessTranscriptTool.from(it) },
                model = json.optStringOrNull("model"),
            )
        }
    }
}

/** `GET /api/harness-sessions/:enc/transcript`. */
data class HarnessTranscript(
    val sessionId: String,
    val harnessId: String,
    val turns: List<HarnessTranscriptTurn>,
    /** Canonical id a superseded/legacy id was resolved to, when it differed. */
    val redirectedTo: String?,
) {
    companion object {
        fun from(json: JSONObject): HarnessTranscript = HarnessTranscript(
            sessionId = json.optString("sessionId", ""),
            harnessId = json.optString("harnessId", ""),
            turns = json.optJSONArray("turns").objects().mapNotNull { HarnessTranscriptTurn.from(it) },
            redirectedTo = json.optStringOrNull("redirectedTo"),
        )
    }
}

/** The `allow-session` scope is every future call of the same tool name. */
enum class ApprovalDecision(val wire: String) {
    ALLOW("allow"),
    DENY("deny"),
    ALLOW_SESSION("allow-session"),
}

/**
 * One frame off a session or registry socket.
 *
 * Unknown `type`s become [Unknown] rather than being dropped: a future server
 * adding an event must not look like a dead stream, and the fold ignores them.
 */
sealed class HarnessEvent {
    abstract val sessionId: String

    data class AssistantDelta(override val sessionId: String, val text: String) : HarnessEvent()

    data class ReasoningDelta(override val sessionId: String, val text: String) : HarnessEvent()

    data class ToolUse(
        override val sessionId: String,
        val toolCallId: String,
        val name: String,
    ) : HarnessEvent()

    data class ToolResult(
        override val sessionId: String,
        val toolCallId: String,
        val name: String,
        val isError: Boolean,
    ) : HarnessEvent()

    data class ApprovalRequest(
        override val sessionId: String,
        val requestId: String,
        val name: String,
        val reason: String?,
    ) : HarnessEvent()

    data class ApprovalResolved(
        override val sessionId: String,
        val requestId: String,
        val decision: String,
    ) : HarnessEvent()

    data class SessionCreated(
        override val sessionId: String,
        val summary: HarnessSessionSummary?,
    ) : HarnessEvent()

    data class TurnComplete(
        override val sessionId: String,
        val stopReason: String?,
    ) : HarnessEvent()

    data class Error(
        override val sessionId: String,
        val code: String,
        val message: String,
        val retryable: Boolean?,
    ) : HarnessEvent()

    data class SessionUpdated(
        override val sessionId: String,
        val previousSessionId: String?,
        val status: HarnessStatus,
    ) : HarnessEvent()

    data class Unknown(override val sessionId: String, val type: String) : HarnessEvent()

    companion object {
        /** Parse one frame; null when the payload is not an object we can read. */
        fun from(json: JSONObject): HarnessEvent? {
            val sessionId = json.optString("sessionId", "")
            return when (val type = json.optString("type")) {
                "assistant-delta" -> AssistantDelta(sessionId, json.optString("text", ""))
                "reasoning-delta" -> ReasoningDelta(sessionId, json.optString("text", ""))
                "tool-use" -> ToolUse(
                    sessionId,
                    json.optString("toolCallId", ""),
                    json.optString("name", ""),
                )

                "tool-result" -> ToolResult(
                    sessionId,
                    json.optString("toolCallId", ""),
                    json.optString("name", ""),
                    json.optBoolean("isError", false),
                )

                "approval-request" -> ApprovalRequest(
                    sessionId,
                    json.optString("requestId", ""),
                    json.optString("name", ""),
                    json.optStringOrNull("reason"),
                )

                "approval-resolved" -> ApprovalResolved(
                    sessionId,
                    json.optString("requestId", ""),
                    json.optString("decision", ""),
                )

                "session-created" -> SessionCreated(
                    sessionId,
                    json.optJSONObject("summary")?.let { HarnessSessionSummary.from(it) },
                )

                "turn-complete" -> TurnComplete(sessionId, json.optStringOrNull("stopReason"))
                "error" -> Error(
                    sessionId,
                    json.optString("code", "error"),
                    json.optString("message", ""),
                    if (json.has("retryable")) json.optBoolean("retryable") else null,
                )

                "session-updated" -> SessionUpdated(
                    sessionId,
                    json.optStringOrNull("previousSessionId"),
                    HarnessStatus.from(json.optStringOrNull("status")),
                )

                "" -> null
                else -> Unknown(sessionId, type)
            }
        }

        /** Parse a raw WS text frame; null for anything unreadable. */
        fun parse(text: String): HarnessEvent? =
            runCatching { JSONObject(text) }.getOrNull()?.let { from(it) }
    }
}

// -- small org.json helpers ---------------------------------------------------

/** `optString` that reports absent/blank/JSON-null as null rather than "". */
internal fun JSONObject.optStringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val value = optString(key, "")
    return value.ifBlank { null }
}

internal fun JSONArray?.objects(): List<JSONObject> {
    if (this == null) return emptyList()
    val out = ArrayList<JSONObject>(length())
    for (i in 0 until length()) {
        optJSONObject(i)?.let { out.add(it) }
    }
    return out
}

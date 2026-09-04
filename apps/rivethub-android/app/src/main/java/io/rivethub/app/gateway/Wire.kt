package io.rivethub.app.gateway

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Wire shapes — verbatim from @rivetos/types gateway-api.ts / den-protocol. */

val wireJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    coerceInputValues = true
}

@Serializable
data class MeshDenNode(
    val id: String,
    val name: String = "",
    val denUrl: String = "",
    val online: Boolean = false,
    val sessions: Int? = null,
)

@Serializable
data class MeshOverview(val updatedAt: Long = 0, val nodes: List<MeshDenNode> = emptyList())

@Serializable
data class CatalogAgent(
    val id: String,
    val node: String = "",
    val local: Boolean = false,
    val provider: String? = null,
    val model: String? = null,
)

@Serializable
data class CatalogAgentsResponse(val agents: List<CatalogAgent> = emptyList())

@Serializable
data class Healthz(val ok: Boolean = false, val sessions: Int = 0, val name: String = "")

@Serializable
data class MessageUsage(val promptTokens: Int = 0, val completionTokens: Int = 0, val cachedTokens: Int = 0)

@Serializable
data class TranscriptTool(val name: String, val status: String = "done")

@Serializable
data class SessionMessage(
    val id: String,
    val sessionId: String = "",
    val role: String,
    val text: String = "",
    val ts: Long = 0,
    val model: String? = null,
    val durationMs: Long? = null,
    val thinking: String? = null,
    val tools: List<TranscriptTool>? = null,
    val usage: MessageUsage? = null,
)

@Serializable
data class SessionMessagesResponse(val messages: List<SessionMessage> = emptyList())

@Serializable
data class SessionSummary(val id: String, val lastActive: Long = 0, val messages: Int = 0)

@Serializable
data class SessionsListResponse(val sessions: List<SessionSummary> = emptyList())

@Serializable
data class SessionPostRequest(val text: String, val userId: String? = null, val agent: String? = null)

@Serializable
data class SessionPostAccepted(val accepted: Boolean = false, val session: String = "")

@Serializable
data class DenTask(val label: String = "", val done: Boolean = false)

@Serializable
data class DenLogEntry(val who: String = "agent", val text: String = "")

@Serializable
data class RoomState(
    val title: String = "",
    val activity: String = "idle",
    val tool: String? = null,
    val tasks: List<DenTask> = emptyList(),
    val thought: String = "",
    val lastMessage: String = "",
    val log: List<DenLogEntry> = emptyList(),
    val term: List<String> = emptyList(),
    val ended: Boolean = false,
)

@Serializable
data class DenStateResponse(val session: String = "", val state: RoomState = RoomState())

@Serializable
data class DenSessionInfo(val id: String, val name: String = "", val harness: String? = null, val lastEventTs: Long? = null)

/** Frames on WS /api/sessions/ws. The union is discriminated by `kind`. */
sealed interface SessionFrame {
    data class Message(val message: SessionMessage) : SessionFrame
    data class Stream(val session: String, val type: String, val content: String, val metadata: JsonObject?) : SessionFrame
    data object SessionsDirty : SessionFrame
    data class Other(val kind: String) : SessionFrame
}

fun parseSessionFrame(text: String): SessionFrame? {
    val el = runCatching { wireJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
    val kind = el["kind"]?.jsonPrimitive?.content ?: return null
    return when (kind) {
        "message" -> runCatching {
            SessionFrame.Message(wireJson.decodeFromJsonElement(SessionMessage.serializer(), el))
        }.getOrNull()
        "stream" -> {
            val ev = el["event"]?.jsonObject ?: return SessionFrame.Other(kind)
            SessionFrame.Stream(
                session = el["session"]?.jsonPrimitive?.content ?: "",
                type = ev["type"]?.jsonPrimitive?.content ?: "",
                content = ev["content"]?.jsonPrimitive?.content ?: "",
                metadata = ev["metadata"] as? JsonObject,
            )
        }
        "sessions-dirty" -> SessionFrame.SessionsDirty
        else -> SessionFrame.Other(kind)
    }
}

/** Frames on WS /api/events/ws: one snapshot on connect, then raw den events. */
sealed interface DenFrame {
    data class Snapshot(val rooms: Map<String, RoomState>, val sessions: List<DenSessionInfo>) : DenFrame
    data class Event(val type: String, val session: String) : DenFrame
}

fun parseDenFrame(text: String): DenFrame? {
    val el = runCatching { wireJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
    val type = el["type"]?.jsonPrimitive?.content ?: return null
    if (type == "snapshot") {
        val rooms = (el["rooms"] as? JsonObject)?.mapValues { (_, v) ->
            runCatching { wireJson.decodeFromJsonElement(RoomState.serializer(), v) }.getOrDefault(RoomState())
        } ?: emptyMap()
        val sessions = el["sessions"]?.let {
            runCatching { wireJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(DenSessionInfo.serializer()), it) }.getOrNull()
        } ?: emptyList()
        return DenFrame.Snapshot(rooms, sessions)
    }
    return DenFrame.Event(type, el["session"]?.jsonPrimitive?.content ?: "")
}

// -- /api/terminal (den PTY surface; shapes from @rivetos/types gateway-api.ts) --

@Serializable
data class TermCommand(val id: String, val label: String = "", val room: Boolean = false)

@Serializable
data class TermConfigResponse(
    val enabled: Boolean = false,
    val default: String = "",
    val maxPtys: Int = 0,
    val active: Int = 0,
    val commands: List<TermCommand> = emptyList(),
)

@Serializable
data class TermSpawnRequest(
    val command: String? = null,
    val session: String? = null,
    val resume: String? = null,
    val cols: Int? = null,
    val rows: Int? = null,
    val model: String? = null,
    val effort: String? = null,
)

@Serializable
data class TermAttachInfo(
    val socket: String,
    val session: String,
    val host: String,
    val sshUser: String,
    val local: Boolean = false,
)

@Serializable
data class TermSpawnResponse(
    val id: String,
    val denSession: String = "",
    val command: String = "",
    val pid: Int = 0,
    val createdAt: Long = 0,
    val mux: String? = null,
    val reattached: Boolean = false,
    val attach: TermAttachInfo? = null,
)

@Serializable
data class PtyInfo(
    val id: String,
    val denSession: String = "",
    val command: String = "",
    val state: String = "running",
    val pid: Int = 0,
    val attached: Int = 0,
    val exitCode: Int? = null,
    val createdAt: Long = 0,
    val lastOutputTs: Long? = null,
    val cols: Int = 80,
    val rows: Int = 24,
    val mux: String? = null,
    val attach: TermAttachInfo? = null,
)

@Serializable
data class TermListResponse(val ptys: List<PtyInfo> = emptyList())

@Serializable
data class TermOwner(
    val device: String,
    val self: Boolean = false,
)

@Serializable
data class TermHelloFrame(
    val type: String = "hello",
    val v: Int = 1,
    val id: String = "",
    val denSession: String = "",
    val command: String = "",
    val cols: Int = 80,
    val rows: Int = 24,
    val state: String = "running",
    val exitCode: Int? = null,
    val mux: String? = null,
    /** Present when this session already has a terminal owner (den #681).
     *  Absent until the first viewer resizes (auto-claim). `self` is per-recipient. */
    val owner: TermOwner? = null,
)

@Serializable
data class TermExitFrame(
    val type: String = "exit",
    val code: Int? = null,
    val signal: String? = null,
)

/** Server → client: ownership of the shared PTY changed (den #681).
 *  `device` null = nobody owns it; `self` is per-recipient. */
@Serializable
data class TermOwnerFrame(
    val type: String = "owner",
    val device: String? = null,
    val self: Boolean = false,
    val since: Long? = null,
)

@Serializable
data class TermResizeFrame(val type: String = "resize", val cols: Int, val rows: Int)

/** Client → server: take ownership of the shared PTY. Optional size is
 *  applied (clamped like resize); omitted → the client's last resize. */
@Serializable
data class TermClaimFrame(val type: String = "claim", val cols: Int? = null, val rows: Int? = null)

/**
 * Deliberately ahead of `@rivetos/types` `TermControlFrame` (`resize | kill`
 * only). den-server `term/ws.ts` currently ignores it; the TCP close is the
 * detach. Harmless no-op on today's server, never `{type:kill}`.
 */
@Serializable
data class TermDetachFrame(val type: String = "detach")

@Serializable
data class TermInjectRequest(
    val session: String,
    val text: String,
    val submit: Boolean? = null,
    val interrupt: Boolean? = null,
)

@Serializable
data class TermInjectResponse(
    val ok: Boolean = false,
    val ptyId: String = "",
)

@Serializable
data class AgentPreset(
    val id: String,
    val name: String = "",
    val color: String = "",
    val harnessId: String? = null,
    val model: String = "",
    val effort: String = "",
    val systemPrompt: String = "",
    val nodeBaseUrl: String = "",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

@Serializable
data class AgentsListResponse(val agents: List<AgentPreset> = emptyList())

/** JSON text frames on WS /api/terminal/ws (binary frames are raw PTY bytes). */
sealed interface TermFrame {
    data class Hello(val frame: TermHelloFrame) : TermFrame
    data class Exit(val frame: TermExitFrame) : TermFrame
    data class Owner(val frame: TermOwnerFrame) : TermFrame
}

fun parseTermFrame(text: String): TermFrame? {
    val el = runCatching { wireJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
    return when (el["type"]?.jsonPrimitive?.content) {
        "hello" -> runCatching { TermFrame.Hello(wireJson.decodeFromJsonElement(TermHelloFrame.serializer(), el)) }.getOrNull()
        "exit" -> runCatching { TermFrame.Exit(wireJson.decodeFromJsonElement(TermExitFrame.serializer(), el)) }.getOrNull()
        "owner" -> runCatching { TermFrame.Owner(wireJson.decodeFromJsonElement(TermOwnerFrame.serializer(), el)) }.getOrNull()
        else -> null
    }
}

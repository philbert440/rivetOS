package io.rivethub.app.gateway

import kotlinx.serialization.Serializable

// -- /api/hub/state (shapes from @rivetos/types hub-state.ts) --
//
// One small per-user document on the entry den: projects, which session sits
// in which project, custom names, archive, pins, hidden, chat/terminal modes,
// last open session. Every per-session key is `<nodeId>::<sessionKey>`, where
// the node id is the den's `/healthz.node`.

@Serializable
data class HubProjectDefaults(
    val agentId: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val harnessId: String? = null,
    /** Den node id (`/healthz.node`), not a URL. */
    val node: String? = null,
    /** Absolute working directory on [node]. */
    val directory: String? = null,
)

@Serializable
data class HubProject(
    val id: String,
    val name: String,
    val order: Double = 0.0,
    val createdAt: Long = 0,
    val defaults: HubProjectDefaults? = null,
)

@Serializable
data class HubLastSession(val key: String, val at: Long)

@Serializable
data class HubState(
    val projects: List<HubProject> = emptyList(),
    val defaultProjectId: String? = null,
    val membership: Map<String, String> = emptyMap(),
    val names: Map<String, String> = emptyMap(),
    val archived: List<String> = emptyList(),
    val pinned: List<String> = emptyList(),
    val hidden: List<String> = emptyList(),
    val modes: Map<String, String> = emptyMap(),
    val lastSession: HubLastSession? = null,
)

@Serializable
data class HubStateResponse(val version: Long = 0, val state: HubState = HubState())

@Serializable
data class HubStatePutRequest(val baseVersion: Long, val state: HubState)

/** A PUT either landed, or lost to a newer document the caller must merge onto. */
sealed interface HubStatePutResult {
    val doc: HubStateResponse
    data class Saved(override val doc: HubStateResponse) : HubStatePutResult
    data class Conflict(override val doc: HubStateResponse) : HubStatePutResult
}

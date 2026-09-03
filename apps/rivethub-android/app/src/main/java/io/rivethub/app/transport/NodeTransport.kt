package io.rivethub.app.transport

import io.rivethub.app.domain.Bot
import io.rivethub.app.gateway.Gateway

data class NodeRef(
    val id: String,
    val name: String,
    val denUrl: String,
    val online: Boolean,
    /** Mesh `sessions` count when known; not part of the identity key. */
    val sessions: Int? = null,
    /** false for a node the user added by URL that the mesh doesn't advertise. */
    val fromMesh: Boolean = true,
)

interface NodeTransport {
    /** Point the transport at an entry node and the user's extra node URLs. */
    fun retarget(entryUrl: String, extraNodes: Set<String>)
    /** Roster discovered from the entry node (`GET /api/mesh` + probes). */
    suspend fun discover(): List<NodeRef>
    /** Gateway for talking to ONE node. Same instance for the same node while the identity generation holds. */
    fun gateway(node: NodeRef): Gateway
    /** Entry-node gateway (datahub). */
    fun entry(): Gateway
    /** Drop cached gateways (identity or TLS posture changed). */
    fun clear()
}

fun Bot.toNodeRef(): NodeRef = NodeRef(
    id = nodeId,
    name = nodeName,
    denUrl = denUrl,
    online = online,
    sessions = nodeSessions,
)

/** Host part of a node URL, or the URL itself when it does not parse. */
fun hostOfUrl(url: String): String = runCatching { java.net.URI(url).host ?: url }.getOrDefault(url)

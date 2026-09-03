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
)

interface NodeTransport {
    /** Roster discovered from the entry node (`GET /api/mesh` + probes). */
    suspend fun discover(): List<NodeRef>
    /** Gateway for talking to ONE node. Same instance for the same node while the identity generation holds. */
    fun gateway(node: NodeRef): Gateway
    /** Entry-node gateway (datahub). */
    fun entry(): Gateway
}

fun Bot.toNodeRef(): NodeRef = NodeRef(
    id = nodeId,
    name = nodeName,
    denUrl = denUrl,
    online = online,
    sessions = nodeSessions,
)

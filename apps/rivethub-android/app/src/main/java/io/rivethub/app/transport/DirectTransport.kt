package io.rivethub.app.transport

import io.rivethub.app.gateway.Gateway
import io.rivethub.app.gateway.GatewayClients

/**
 * Per-node `denUrl` transport. IngressTransport (the `/api/nodes/:id/...` relay) is a later drop-in.
 */
class DirectTransport(
    entryUrl: String,
    extraNodes: Set<String>,
    private val clients: GatewayClients,
) : NodeTransport {
    private val cache = HashMap<String, Pair<String, Gateway>>()

    @Volatile private var entryUrl: String = entryUrl
    @Volatile private var extraNodes: Set<String> = extraNodes

    @Synchronized
    override fun retarget(entryUrl: String, extraNodes: Set<String>) {
        this.entryUrl = entryUrl
        this.extraNodes = extraNodes
    }

    @Synchronized
    override fun clear() = cache.clear()

    override suspend fun discover(): List<NodeRef> {
        val entry = entry()
        val mesh = entry.mesh()
        val entryNode = runCatching { entry.healthz().node }.getOrDefault("")
        val fromMesh = withEntryUrl(
            mesh.nodes.filter { it.denUrl.isNotBlank() }.map {
                NodeRef(id = it.id, name = it.name, denUrl = it.denUrl, online = it.online, sessions = it.sessions)
            },
            entryNode,
            entryUrl,
        )
        val extra = extraNodes.filter { u ->
            fromMesh.none { it.denUrl.trimEnd('/') == u.trimEnd('/') }
        }
        return fromMesh + extra.map { u ->
            val host = hostOf(u)
            NodeRef(id = host, name = host, denUrl = u, online = true, fromMesh = false)
        }
    }

    override fun gateway(node: NodeRef): Gateway = gatewayForUrl(node.denUrl)

    override fun entry(): Gateway = gatewayForUrl(entryUrl)

    @Synchronized
    private fun gatewayForUrl(baseUrl: String): Gateway {
        val key = clients.cacheKey()
        val norm = baseUrl.trim().trimEnd('/')
        cache[norm]?.let { (k, g) -> if (k == key) return g }
        val g = Gateway(clients.primary(), norm, clients.fallback())
        cache[norm] = key to g
        return g
    }

    companion object {
        fun hostOf(url: String): String = hostOfUrl(url)

        /**
         * The entry node is reached at the URL the user typed, not the one it
         * advertises to the mesh: a node advertises its LAN address, which a
         * phone on Tailscale (or any other route) cannot reach. [entryNode] is
         * the entry URL's `/healthz` node name; blank leaves every node as is.
         */
        fun withEntryUrl(nodes: List<NodeRef>, entryNode: String, entryUrl: String): List<NodeRef> {
            val url = entryUrl.trim().trimEnd('/')
            if (entryNode.isBlank() || url.isBlank()) return nodes
            return nodes.map { if (it.id == entryNode || it.name == entryNode) it.copy(denUrl = url) else it }
        }
    }
}

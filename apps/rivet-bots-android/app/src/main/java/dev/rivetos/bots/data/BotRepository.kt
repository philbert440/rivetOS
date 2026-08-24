package dev.rivetos.bots.data

import dev.rivetos.bots.domain.Bot
import dev.rivetos.bots.domain.BotPreview
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Roster discovery. One entry node answers `/api/mesh` (every node's gateway
 * URL + online flag) and `/api/catalog/agents` (every agent across the mesh,
 * with provider/model when the owning node advertised them). Each (agent,
 * node) pair becomes a bot. Extra nodes the user added by URL are folded in
 * from their own local catalog.
 */
class BotRepository(private val gateways: GatewayPool) {

    class DiscoveryFailed(message: String, cause: Throwable? = null) : Exception(message, cause)

    suspend fun discover(entryUrl: String, extraNodes: Set<String>): List<Bot> = coroutineScope {
        val entry = gateways.get(entryUrl)
        val mesh = try {
            entry.mesh()
        } catch (e: GatewayException) {
            throw DiscoveryFailed(
                when (e.status) {
                    401, 403 -> "Node refused the device certificate (HTTP ${e.status})."
                    else -> "Entry node error: ${e.message}"
                }, e,
            )
        } catch (e: Exception) {
            throw DiscoveryFailed(friendly(e), e)
        }
        val nodes = mesh.nodes.associateBy { it.id }
        val catalog = runCatching { entry.catalogAgents().agents }.getOrDefault(emptyList())

        val bots = LinkedHashMap<String, Bot>()
        fun put(b: Bot) { bots.putIfAbsent(b.id, b) }

        for (a in catalog) {
            val node = nodes[a.node] ?: continue
            if (node.denUrl.isBlank()) continue
            put(
                Bot(
                    agent = a.id, nodeId = node.id, nodeName = node.name, denUrl = node.denUrl,
                    online = node.online, provider = a.provider, model = a.model, local = a.local,
                    nodeSessions = node.sessions,
                ),
            )
        }

        // Nodes the entry catalog didn't cover (older peers): ask each one for its own agents.
        val uncovered = mesh.nodes.filter { n -> n.denUrl.isNotBlank() && n.online && bots.values.none { it.nodeId == n.id } }
        val extra = extraNodes.filter { u -> nodes.values.none { it.denUrl.trimEnd('/') == u.trimEnd('/') } }
        val probes = uncovered.map { n -> async { probeNode(n.denUrl, n.id, n.name, n.online, n.sessions) } } +
            extra.map { u -> async { probeNode(u, hostOf(u), hostOf(u), true, null) } }
        probes.forEach { d -> d.await().forEach(::put) }

        bots.values.sortedWith(compareByDescending<Bot> { it.online }.thenBy { it.displayName }.thenBy { it.nodeLabel })
    }

    private suspend fun probeNode(denUrl: String, id: String, name: String, online: Boolean, sessions: Int?): List<Bot> {
        val gw = gateways.get(denUrl)
        val agents = withTimeoutOrNull(6_000) { runCatching { gw.catalogAgents().agents.filter { it.local } }.getOrNull() }
        val health = withTimeoutOrNull(4_000) { runCatching { gw.healthz() }.getOrNull() }
        val nodeName = health?.name?.ifBlank { null } ?: name
        if (agents.isNullOrEmpty()) {
            // Reachable but no catalog: only a bot if the node actually serves chat
            // (a bare den-server like datahub answers /healthz but has no gateway).
            val chats = health != null && withTimeoutOrNull(4_000) { runCatching { gw.sessions() }.isSuccess } == true
            return if (chats) listOf(Bot(Bot.DEFAULT_AGENT, id, nodeName, denUrl, true, nodeSessions = health?.sessions)) else emptyList()
        }
        return agents.map { a ->
            Bot(a.id, id, nodeName, denUrl, online || health != null, a.provider, a.model, true, health?.sessions ?: sessions)
        }
    }

    /** Last line of a bot's thread, or null when the node is unreachable / thread empty. */
    suspend fun preview(bot: Bot, sessionId: String): BotPreview? = withTimeoutOrNull(8_000) {
        runCatching { gateways.get(bot.denUrl).messages(sessionId) }.getOrNull()
            ?.lastOrNull()?.let { BotPreview(it.text, it.ts, it.role) }
    }

    companion object {
        fun hostOf(url: String): String = runCatching { java.net.URI(url).host ?: url }.getOrDefault(url)

        fun friendly(e: Throwable): String {
            android.util.Log.w("RivetBots", "request failed", e) // logcat ground truth for field debugging
            return when (e) {
            is javax.net.ssl.SSLHandshakeException -> "TLS handshake failed — check the device certificate and CA chain."
            is javax.net.ssl.SSLPeerUnverifiedException -> "Node certificate doesn't match its address (try relaxed hostname check)."
            is java.net.UnknownHostException -> "Host not found."
            is java.net.ConnectException -> "Connection refused — is the node up and reachable on the mesh?"
            is java.net.SocketTimeoutException -> "Timed out reaching the node."
            is GatewayException -> "HTTP ${e.status}: ${e.message}"
            else -> e.message ?: e.javaClass.simpleName
        }
        }
    }
}

/** One Gateway per base URL, rebuilt when the identity or TLS posture changes. */
class GatewayPool(private val http: HttpFactory, private val strict: () -> Boolean, private val identity: DeviceIdentityStore) {
    private val cache = HashMap<String, Pair<String, Gateway>>()

    @Synchronized
    fun clear() = cache.clear()

    @Synchronized
    fun get(baseUrl: String): Gateway {
        val key = http.cacheKey(strict())
        val norm = baseUrl.trim().trimEnd('/')
        cache[norm]?.let { (k, g) -> if (k == key) return g }
        val g = Gateway(http.client(strict()), norm, http.fallbackClient(strict()))
        cache[norm] = key to g
        return g
    }
}

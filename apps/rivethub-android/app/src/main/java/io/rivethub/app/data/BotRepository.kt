package io.rivethub.app.data

import io.rivethub.app.domain.Bot
import io.rivethub.app.domain.BotPreview
import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.SessionSummary
import io.rivethub.app.transport.DirectTransport
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.transport.NodeTransport
import io.rivethub.app.transport.toNodeRef
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.cancellation.CancellationException

/**
 * Roster discovery. One entry node answers `/api/mesh` (every node's gateway
 * URL + online flag) and `/api/catalog/agents` (every agent across the mesh,
 * with provider/model when the owning node advertised them). Each (agent,
 * node) pair becomes a bot. Extra nodes the user added by URL are folded in
 * from their own local catalog.
 */
class BotRepository(private val transport: NodeTransport) {

    class DiscoveryFailed(message: String, cause: Throwable? = null) : Exception(message, cause)

    suspend fun discover(entryUrl: String, extraNodes: Set<String>): List<Bot> = coroutineScope {
        (transport as? DirectTransport)?.let {
            it.entryUrl = entryUrl
            it.extraNodes = extraNodes
        }
        val nodeList = try {
            transport.discover()
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
        val nodes = nodeList.associateBy { it.id }
        val catalog = runCatching { transport.entry().catalogAgents().agents }.getOrDefault(emptyList())

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
        val uncovered = nodeList.filter { n -> n.denUrl.isNotBlank() && n.online && bots.values.none { it.nodeId == n.id } }
        val probes = uncovered.map { n -> async { probeNode(n) } }
        probes.forEach { d -> d.await().forEach(::put) }

        bots.values.sortedWith(compareByDescending<Bot> { it.online }.thenBy { it.displayName }.thenBy { it.nodeLabel })
    }

    private suspend fun probeNode(node: NodeRef): List<Bot> {
        val gw = transport.gateway(node)
        val denUrl = node.denUrl
        val id = node.id
        val name = node.name
        val online = node.online
        val sessions = node.sessions
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
        runCatching { transport.gateway(bot.toNodeRef()).messages(sessionId) }.getOrNull()
            ?.lastOrNull()?.let {
                val text = if (it.role == "assistant") visibleAssistantText(it.text) else it.text
                BotPreview(text.ifBlank { "…" }, it.ts, it.role)
            }
    }

    /**
     * Session this bot should use. Fetches `/api/sessions` only when [override]
     * is blank. A failed fetch returns [minted] without persist so the next
     * open retries; an empty list persists [minted] (node really has none).
     */
    suspend fun resolveSessionId(bot: Bot, override: String?, minted: String): SessionPick {
        val o = override?.trim().orEmpty()
        if (o.isNotEmpty()) return SessionResolver.adopt(o, null, minted)
        val fetched = withTimeoutOrNull(8_000) {
            try {
                transport.gateway(bot.toNodeRef()).sessions().sessions
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        }
        return SessionResolver.adopt(null, fetched, minted)
    }

    /** Gateway session list for the node that hosts [bot]. Throws on transport/auth errors. */
    suspend fun nodeSessions(bot: Bot): List<SessionSummary> =
        transport.gateway(bot.toNodeRef()).sessions().sessions

    companion object {
        fun hostOf(url: String): String = DirectTransport.hostOf(url)

        fun friendly(e: Throwable): String {
            AndroidLogger.warn("RivetHub", "request failed", e) // logcat ground truth for field debugging
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

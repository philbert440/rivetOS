package io.rivethub.app.plane

/**
 * Sticky per-agent session pointer. Set-once unless [replace] is true —
 * `+ new` never steals the pin (call set with replace=false). In-memory
 * for this slice; M3b persists it.
 *
 * [AgentPointers] is not thread-safe; confine to a single dispatcher
 * (the ViewModel's).
 */
data class AgentPointer(
    val sessionId: String,
    val nodeBaseUrl: String,
    val updatedAt: Long = 0,
)

class AgentPointers(
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    private val byAgent = LinkedHashMap<String, AgentPointer>()
    private val bind = LinkedHashMap<String, String>()

    fun get(agentId: String): AgentPointer? = byAgent[agentId]

    fun agentForSession(sessionId: String): String? = bind[sessionId]

    /**
     * @return false when the write was refused (set-once, pin already held).
     */
    fun set(
        agentId: String,
        sessionId: String,
        nodeBaseUrl: String,
        replace: Boolean = false,
    ): Boolean {
        val existing = byAgent[agentId]
        if (!replace && existing != null) return false
        if (replace && existing != null) bind.remove(existing.sessionId)
        byAgent[agentId] = AgentPointer(sessionId, nodeBaseUrl, nowMs())
        bind[sessionId] = agentId
        return true
    }

    fun clear(agentId: String) {
        val prev = byAgent.remove(agentId) ?: return
        bind.remove(prev.sessionId)
    }

    fun rekey(fromSessionId: String, toSessionId: String) {
        if (fromSessionId.isEmpty() || fromSessionId == toSessionId) return
        for ((agentId, ptr) in byAgent.entries.toList()) {
            if (ptr.sessionId == fromSessionId) {
                byAgent[agentId] = ptr.copy(sessionId = toSessionId)
            }
        }
        val agentId = bind.remove(fromSessionId)
        if (agentId != null) bind[toSessionId] = agentId
    }

    fun all(): Map<String, AgentPointer> = byAgent.toMap()
}

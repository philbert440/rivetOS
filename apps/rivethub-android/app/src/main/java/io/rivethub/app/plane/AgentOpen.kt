package io.rivethub.app.plane

enum class AgentAction { Tap, Replace, Plus }

data class AgentOpen(
    val sessionId: String,
    val nodeDenUrl: String,
    val harnessId: String?,
    val draft: Boolean,
    val pinMoved: Boolean,
    val model: String = "",
    val effort: String = "",
)

/**
 * Pointer semantics from desktop `agents-section.tsx`:
 * tap opens the pin or mints and pins a draft; ↺ mints a draft and moves
 * the pin; + mints a draft and leaves the pin alone.
 */
fun openAgent(
    pointers: AgentPointers,
    agentId: String,
    nodeDenUrl: String,
    harnessId: String?,
    action: AgentAction,
    newId: () -> String = ::newDraftId,
): AgentOpen {
    if (action == AgentAction.Tap) {
        val pin = pointers.get(agentId)
        if (pin != null) {
            return AgentOpen(
                sessionId = pin.sessionId,
                nodeDenUrl = pin.nodeBaseUrl,
                harnessId = harnessId,
                draft = false,
                pinMoved = false,
            )
        }
        val draft = newId()
        pointers.set(agentId, draft, nodeDenUrl, replace = false)
        return AgentOpen(draft, nodeDenUrl, harnessId, draft = true, pinMoved = true)
    }
    val draft = newId()
    if (action == AgentAction.Plus) {
        return AgentOpen(draft, nodeDenUrl, harnessId, draft = true, pinMoved = false)
    }
    val moved = pointers.set(agentId, draft, nodeDenUrl, replace = true)
    return AgentOpen(draft, nodeDenUrl, harnessId, draft = true, pinMoved = moved)
}

fun pointerSessionKeys(pointers: AgentPointers): Set<String> =
    pointers.all().values.map { it.sessionId }.toSet()

data class AgentRow(
    val agentId: String,
    val name: String,
    val harnessId: String?,
    val nodeId: String,
    val nodeName: String,
    val nodeDenUrl: String,
    val pointerSessionId: String?,
    val color: String = "",
    val model: String = "",
    val effort: String = "",
    val online: Boolean = true,
)

fun agentRow(
    agentId: String,
    name: String,
    harnessId: String?,
    nodeId: String,
    nodeName: String,
    nodeDenUrl: String,
    pointers: AgentPointers,
    color: String = "",
    model: String = "",
    effort: String = "",
    online: Boolean = true,
): AgentRow = AgentRow(
    agentId = agentId,
    name = name,
    harnessId = harnessId,
    nodeId = nodeId,
    nodeName = nodeName,
    nodeDenUrl = nodeDenUrl,
    pointerSessionId = pointers.get(agentId)?.sessionId,
    color = color,
    model = model,
    effort = effort,
    online = online,
)

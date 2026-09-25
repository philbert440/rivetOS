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
    val agentId: String = "",
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
                draft = isDraftSessionId(pin.sessionId),
                pinMoved = false,
                agentId = agentId,
            )
        }
        val draft = newId()
        pointers.set(agentId, draft, nodeDenUrl, replace = false)
        return AgentOpen(draft, nodeDenUrl, harnessId, draft = true, pinMoved = true, agentId = agentId)
    }
    val draft = newId()
    if (action == AgentAction.Plus) {
        return AgentOpen(draft, nodeDenUrl, harnessId, draft = true, pinMoved = false, agentId = agentId)
    }
    val moved = pointers.set(agentId, draft, nodeDenUrl, replace = true)
    return AgentOpen(draft, nodeDenUrl, harnessId, draft = true, pinMoved = moved, agentId = agentId)
}

/**
 * Chat destination for [row], or null when the row must not open.
 * An unmatched preset is offline and its den URL is empty. Opening it
 * would mint a draft pointed at that URL; chat boot then builds a gateway
 * from the empty string and throws outside the boot catch. Null means do
 * not navigate and do not touch [pointers].
 */
fun openAgentRow(
    row: AgentRow,
    pointers: AgentPointers,
    action: AgentAction,
    newId: () -> String = ::newDraftId,
): AgentOpen? {
    if (!row.online || row.nodeDenUrl.isBlank()) return null
    return openAgent(pointers, row.agentId, row.nodeDenUrl, row.harnessId, action, newId)
        .copy(model = row.model, effort = row.effort)
}

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
    val systemPrompt: String = "",
    /** Mesh node name from the preset. Empty on older dens. */
    val node: String = "",
    /** Absolute preset cwd. Empty when unset. */
    val directory: String = "",
    /** Shared-directory link. Default matches the wire. */
    val sharedLink: Boolean = true,
)

/**
 * Dim second line for a drawer or picker row: `node · basename(directory)`.
 * Either half may be blank; both blank yields an empty string.
 */
fun agentRowSubtitle(row: AgentRow): String {
    val node = row.node.trim()
    val base = directoryBasename(row.directory)
    return when {
        node.isNotEmpty() && base.isNotEmpty() -> "$node · $base"
        node.isNotEmpty() -> node
        else -> base
    }
}

/** Last path segment, with a trailing slash ignored. Blank stays blank. */
fun directoryBasename(directory: String): String {
    val trimmed = directory.trim().trimEnd('/', '\\')
    if (trimmed.isEmpty()) return ""
    val slash = maxOf(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return if (slash >= 0) trimmed.substring(slash + 1) else trimmed
}

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
    systemPrompt: String = "",
    node: String = "",
    directory: String = "",
    sharedLink: Boolean = true,
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
    systemPrompt = systemPrompt,
    node = node,
    directory = directory,
    sharedLink = sharedLink,
)

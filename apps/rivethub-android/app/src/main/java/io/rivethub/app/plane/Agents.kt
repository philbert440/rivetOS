package io.rivethub.app.plane

import io.rivethub.app.gateway.AgentPreset
import io.rivethub.app.gateway.CatalogAgent

/** Discovered-node fields [buildAgents] needs — no transport import. */
data class AgentNodeHint(
    val id: String,
    val name: String,
    val denUrl: String,
    val online: Boolean,
)

data class SourcedPreset(
    val preset: AgentPreset,
    val sourceDenUrl: String,
)

/**
 * Fan-in of per-node `GET /api/agents`. Failures drop out (allSettled);
 * first-seen agent id wins, matching desktop `agents-section.tsx`.
 */
fun unionPresets(
    perNode: List<Pair<String, Result<List<AgentPreset>>>>,
): List<SourcedPreset> {
    val out = ArrayList<SourcedPreset>()
    val seen = HashSet<String>()
    for ((source, result) in perNode) {
        val list = result.getOrNull() ?: continue
        for (p in list) {
            if (!seen.add(p.id)) continue
            out += SourcedPreset(p, source)
        }
    }
    return out
}

/**
 * Bind a preset to a discovered node by `nodeBaseUrl` only. Never guess
 * `healthy.firstOrNull()` or match agent id against node id. An unmatched
 * preset keeps its own URL and is offline.
 *
 * Blank `nodeBaseUrl` uses the node that served the row (desktop
 * `sourceNodeBaseUrl`).
 */
fun resolvePresetNode(preset: AgentPreset, sourceDenUrl: String, nodes: List<AgentNodeHint>): AgentNodeHint {
    val raw = preset.nodeBaseUrl.ifBlank { sourceDenUrl }
    val url = raw.trimEnd('/')
    val matched = nodes.find { it.denUrl.trimEnd('/') == url }
    if (matched != null) return matched
    return AgentNodeHint(
        id = displayHost(raw),
        name = raw.ifBlank { url },
        denUrl = raw,
        online = false,
    )
}

/**
 * Preset rows when any node returned agents; otherwise catalog. An empty
 * `{agents:[]}` from every node is a fallback, not an empty Agents screen.
 */
fun buildAgents(
    nodes: List<AgentNodeHint>,
    perNodePresets: List<Pair<String, Result<List<AgentPreset>>>>,
    catalog: List<CatalogAgent>,
    pointers: AgentPointers,
): List<AgentRow> {
    val union = unionPresets(perNodePresets)
    if (union.isNotEmpty()) {
        return union.map { sourced ->
            val node = resolvePresetNode(sourced.preset, sourced.sourceDenUrl, nodes)
            val p = sourced.preset
            val hid = p.harnessId?.takeIf { it.isNotBlank() } ?: harnessIdForAgent(p.id, null)
            agentRow(
                p.id, p.name.ifBlank { p.id }, hid, node.id, node.name.ifBlank { node.id }, node.denUrl,
                pointers, color = p.color, model = p.model, effort = p.effort, online = node.online,
                systemPrompt = p.systemPrompt,
            )
        }
    }
    return catalog.mapNotNull { a ->
        val node = nodes.find { it.id == a.node } ?: return@mapNotNull null
        val hid = harnessIdForAgent(a.id, a.provider)
        agentRow(a.id, a.id, hid, node.id, node.name.ifBlank { node.id }, node.denUrl, pointers, online = node.online)
    }
}

internal fun displayHost(url: String): String {
    val rest = url.trim().removePrefix("https://").removePrefix("http://")
    val host = rest.substringBefore("/").substringBefore(":")
    return host.ifBlank { url }
}

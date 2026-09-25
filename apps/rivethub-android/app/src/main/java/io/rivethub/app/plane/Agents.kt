package io.rivethub.app.plane

import io.rivethub.app.gateway.AgentPreset
import io.rivethub.app.gateway.CatalogAgent

/** Discovered-node fields [buildAgents] needs — no transport import. */
data class AgentNodeHint(
    val id: String,
    val name: String,
    val denUrl: String,
    val online: Boolean,
    /**
     * Mesh node name from `Healthz.node`. When that field is missing, the
     * hub fills this from the mesh node's id, then its name.
     */
    val meshNode: String = "",
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
 * Bind a preset to a discovered node. Order:
 * (1) non-blank `preset.node` equal to a hint's meshNode, id, or name
 * (case-insensitive);
 * (2) a non-blank `preset.node` that matches nothing is an offline hint
 * named after that node — never the den that happened to answer, and never
 * its `nodeBaseUrl`;
 * (3) else a non-blank `nodeBaseUrl` matched by URL, as before (blank node only);
 * (4) else the node that served the row.
 * Never guess the first healthy node, and never match an agent id against a
 * node id. An unmatched URL keeps that URL and is offline.
 */
fun resolvePresetNode(preset: AgentPreset, sourceDenUrl: String, nodes: List<AgentNodeHint>): AgentNodeHint {
    val want = preset.node.trim()
    if (want.isNotEmpty()) {
        val named = nodes.find { hintMatchesNode(it, want) }
        if (named != null) return named
        return AgentNodeHint(
            id = want,
            name = want,
            denUrl = "",
            online = false,
            meshNode = want,
        )
    }
    val rawUrl = preset.nodeBaseUrl.trim()
    if (rawUrl.isNotEmpty()) return matchDenUrl(rawUrl, nodes)
    return matchDenUrl(sourceDenUrl, nodes)
}

private fun hintMatchesNode(hint: AgentNodeHint, want: String): Boolean =
    hint.meshNode.equals(want, ignoreCase = true) ||
        hint.id.equals(want, ignoreCase = true) ||
        hint.name.equals(want, ignoreCase = true)

private fun matchDenUrl(raw: String, nodes: List<AgentNodeHint>): AgentNodeHint {
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
                node = p.node, directory = p.directory, sharedLink = p.sharedLink,
            )
        }
    }
    return catalog.mapNotNull { a ->
        val node = nodes.find { it.id == a.node } ?: return@mapNotNull null
        val hid = a.harnessId?.takeIf { it.isNotBlank() } ?: harnessIdForAgent(a.id, a.provider)
        agentRow(
            a.id, a.name.ifBlank { a.id }, hid, node.id, node.name.ifBlank { node.id }, node.denUrl,
            pointers, online = node.online, model = a.model.orEmpty(),
            node = a.node, directory = a.directory.orEmpty(),
        )
    }
}

internal fun displayHost(url: String): String {
    val rest = url.trim().removePrefix("https://").removePrefix("http://")
    val host = rest.substringBefore("/").substringBefore(":")
    return host.ifBlank { url }
}

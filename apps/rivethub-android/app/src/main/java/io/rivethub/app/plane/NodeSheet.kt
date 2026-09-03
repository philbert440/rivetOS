package io.rivethub.app.plane

data class NodeSheetInput(
    val id: String,
    val name: String,
    val denUrl: String,
    val sessions: Int? = null,
)

data class NodeSheetRow(
    val id: String,
    val name: String,
    val denUrl: String,
    val current: Boolean,
    val saved: Boolean,
    val marker: String,
    val sessions: Int? = null,
    val error: String? = null,
    val removable: Boolean,
)

data class NodeSheetModel(
    val saved: List<NodeSheetRow>,
    val discovered: List<NodeSheetRow>,
    val meshUnavailable: Boolean,
)

private fun normUrl(url: String): String = url.trim().trimEnd('/')

fun nodeSheetMarker(current: Boolean): String = if (current) "●" else "○"

/**
 * Split the mesh roster into saved vs discovered-but-unsaved, matching
 * `node-switcher.tsx`. [viewNodeId] is the current view-filter (never rebinds
 * an open chat). The entry URL is saved and not removable.
 */
fun buildNodeSheet(
    entryUrl: String,
    extraUrls: Set<String>,
    nodes: List<NodeSheetInput>,
    viewNodeId: String,
    nodeErrors: Map<String, String> = emptyMap(),
    meshUnavailable: Boolean = false,
): NodeSheetModel {
    val entry = normUrl(entryUrl)
    val savedUrls = LinkedHashSet<String>()
    if (entry.isNotEmpty()) savedUrls += entry
    extraUrls.forEach { u ->
        val n = normUrl(u)
        if (n.isNotEmpty()) savedUrls += n
    }
    val byUrl = LinkedHashMap<String, NodeSheetInput>()
    for (n in nodes) byUrl[normUrl(n.denUrl)] = n

    fun currentOf(id: String, url: String): Boolean =
        if (viewNodeId.isNotBlank()) id == viewNodeId
        else entry.isNotEmpty() && url == entry

    fun row(url: String, saved: Boolean, input: NodeSheetInput?): NodeSheetRow {
        val id = input?.id ?: url
        val name = input?.name?.ifBlank { id } ?: url
        val current = currentOf(id, url)
        return NodeSheetRow(
            id = id,
            name = name,
            denUrl = url,
            current = current,
            saved = saved,
            marker = nodeSheetMarker(current),
            sessions = input?.sessions,
            error = nodeErrors[id],
            removable = saved && url != entry,
        )
    }

    val saved = savedUrls.map { url -> row(url, saved = true, byUrl[url]) }
    val discovered = nodes
        .map { normUrl(it.denUrl) to it }
        .filter { (url, _) -> url.isNotEmpty() && url !in savedUrls }
        .map { (url, input) -> row(url, saved = false, input) }
    return NodeSheetModel(saved = saved, discovered = discovered, meshUnavailable = meshUnavailable)
}

fun discoveredNodeLabel(name: String, sessions: Int?): String =
    if (sessions != null) "+ $name ($sessions sessions)" else "+ $name"

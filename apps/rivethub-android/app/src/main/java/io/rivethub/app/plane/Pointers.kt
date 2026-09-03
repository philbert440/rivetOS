package io.rivethub.app.plane

data class PointerSnap(val sessionId: String, val nodeBaseUrl: String)

fun encodePointers(all: Map<String, AgentPointer>): Map<String, String> =
    all.mapValues { (_, p) -> "${p.sessionId}\t${p.nodeBaseUrl}" }

fun decodePointers(raw: Map<String, String>): Map<String, PointerSnap> {
    val out = LinkedHashMap<String, PointerSnap>()
    for ((agentId, v) in raw) {
        val tab = v.indexOf('\t')
        if (tab <= 0 || tab == v.length - 1) continue
        out[agentId] = PointerSnap(v.substring(0, tab), v.substring(tab + 1))
    }
    return out
}

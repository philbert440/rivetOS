package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

enum class EnrollErrorKind { CertRefused, Timeout, Unreachable, Other }

data class EnrollError(val kind: EnrollErrorKind, val detail: String? = null)

fun enrollError(err: Throwable): EnrollError {
    var cur: Throwable? = err
    var status: Int? = null
    while (cur != null) {
        if (cur is GatewayException) status = cur.status
        if (cur is SocketTimeoutException) return EnrollError(EnrollErrorKind.Timeout)
        if (cur is UnknownHostException) return EnrollError(EnrollErrorKind.Unreachable)
        cur = cur.cause
    }
    if (status == 401 || status == 403) return EnrollError(EnrollErrorKind.CertRefused)
    return EnrollError(EnrollErrorKind.Other, err.message)
}

fun needsSpawn(kind: ChatItemKind): Boolean = kind == ChatItemKind.DRAFT

fun appearanceFromPref(raw: String?): String = when (raw?.trim()?.lowercase()) {
    "light" -> "light"
    "dark" -> "dark"
    else -> "system"
}

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

fun encodeTitleOverrides(m: Map<String, String>): Map<String, String> =
    m.filterValues { it.isNotBlank() }

/** View-node filter never rebinds an open chat — the open key stays put. */
fun viewFilterLeavesOpenChat(openSessionKey: String, previousViewNode: String?, nextViewNode: String?): Boolean =
    openSessionKey.isNotEmpty() && previousViewNode != nextViewNode

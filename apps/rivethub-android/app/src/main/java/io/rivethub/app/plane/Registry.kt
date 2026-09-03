package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessSessionSummary

data class SessionUpdatedPatch(
    val sessionId: String,
    val status: String,
    val previousSessionId: String? = null,
)

/**
 * Fast path for registry `session-created`: upsert by sessionId. The carried
 * summary wins field-for-field (it is a full SessionSummary, not a patch).
 */
fun mergeSessionCreated(
    snapshot: List<HarnessSessionSummary>,
    summary: HarnessSessionSummary,
): List<HarnessSessionSummary> {
    val i = snapshot.indexOfFirst { it.sessionId == summary.sessionId }
    if (i < 0) return listOf(summary) + snapshot
    if (snapshot[i] == summary) return snapshot
    return snapshot.toMutableList().also { it[i] = summary }
}

/**
 * Fast path for registry `session-updated`: patch status in place. Native-id
 * rotation rewrites sessionId (look up by previousSessionId). Unknown ids
 * return the same list reference so callers can skip a cache write.
 */
fun patchSessionUpdated(
    snapshot: List<HarnessSessionSummary>,
    patch: SessionUpdatedPatch,
): List<HarnessSessionSummary> {
    val lookFor = patch.previousSessionId ?: patch.sessionId
    val i = snapshot.indexOfFirst { it.sessionId == lookFor || it.sessionId == patch.sessionId }
    if (i < 0) return snapshot
    val cur = snapshot[i]
    if (cur.sessionId == patch.sessionId && cur.status == patch.status) return snapshot
    val next = snapshot.toMutableList()
    next[i] = cur.copy(sessionId = patch.sessionId, status = patch.status)
    if (patch.previousSessionId != null && patch.previousSessionId != patch.sessionId) {
        return next.filterIndexed { idx, s -> idx == i || s.sessionId != patch.sessionId }
    }
    return next
}

fun applyRegistryEvent(
    prev: List<HarnessSessionSummary>?,
    type: String,
    sessionId: String,
    summary: HarnessSessionSummary? = null,
    previousSessionId: String? = null,
    status: String? = null,
): List<HarnessSessionSummary>? {
    if (type == "session-created") {
        if (summary == null) return prev
        return mergeSessionCreated(prev ?: emptyList(), summary)
    }
    if (type == "session-updated") {
        if (prev == null || status == null) return prev
        return patchSessionUpdated(
            prev,
            SessionUpdatedPatch(sessionId = sessionId, status = status, previousSessionId = previousSessionId),
        )
    }
    return prev
}

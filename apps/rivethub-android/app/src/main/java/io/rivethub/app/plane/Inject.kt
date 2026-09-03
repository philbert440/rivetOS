package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessSessionSummary
import io.rivethub.app.gateway.denRoomKey
import io.rivethub.app.gateway.nativeIdOf

const val PTY_READY_QUIET_MS: Long = 1_500L
const val PTY_READY_BOUND_MS: Long = 8_000L
const val BARE_SUBMIT_AFTER_MS: Long = 15_000L
const val SESSION_POLL_EVERY_MS: Long = 3_000L
const val SESSION_POLL_BOUND_MS: Long = 30_000L

/**
 * Fresh spawn waits for TUI readiness before inject. Reused (already held
 * locally, or spawn-or-get / tmux reattach) injects immediately — the
 * prompt is already up so a CR will submit.
 */
fun ptySpawnIsFresh(alreadyHeld: Boolean, reattached: Boolean): Boolean =
    !alreadyHeld && !reattached

/**
 * Readiness gate for a freshly spawned PTY. Output must have started and
 * then been quiet for [quietMs], or [boundMs] elapses — whichever first.
 * [nowMs] is injected so tests can drive a fake clock.
 */
class PtyReadyGate(
    private val nowMs: () -> Long,
    private val quietMs: Long = PTY_READY_QUIET_MS,
    private val boundMs: Long = PTY_READY_BOUND_MS,
) {
    private val startedAt = nowMs()
    private var lastOutputAt: Long? = null

    @Synchronized
    fun onOutput() {
        lastOutputAt = nowMs()
    }

    @Synchronized
    fun isReady(): Boolean {
        val t = nowMs()
        if (t - startedAt >= boundMs) return true
        val last = lastOutputAt ?: return false
        return t - last >= quietMs
    }
}

/**
 * Match a registry / listSessions / redirected id against the draft's native
 * id (bare UUID). `nativeIdOf(claude-code:<uuid>)` is the uuid; a bare id
 * compares equal to itself.
 */
fun sessionMatchesNative(sessionId: String?, native: String): Boolean {
    if (sessionId.isNullOrBlank() || native.isBlank()) return false
    if (sessionId == native) return true
    val eventNative = nativeIdOf(sessionId)
    if (eventNative != null && eventNative == native) return true
    val localNative = nativeIdOf(native)
    return localNative != null && (eventNative == localNative || sessionId == localNative)
}

/** First listSessions row whose native id (or redirectedTo) is [native]. */
fun canonicalFromSessions(rows: List<HarnessSessionSummary>, native: String): String? {
    for (row in rows) {
        val hit = when {
            sessionMatchesNative(row.sessionId, native) -> row.sessionId
            sessionMatchesNative(row.redirectedTo, native) -> row.redirectedTo
            else -> null
        }
        if (!hit.isNullOrBlank()) return hit
    }
    return null
}

/** One-shot bare `{text:"", submit:true}` after [BARE_SUBMIT_AFTER_MS] if still a draft. */
fun shouldBareSubmit(adopted: Boolean, elapsedMs: Long, alreadySubmitted: Boolean): Boolean =
    !adopted && !alreadySubmitted && elapsedMs >= BARE_SUBMIT_AFTER_MS

fun shouldPollSessions(elapsedMs: Long): Boolean =
    elapsedMs <= SESSION_POLL_BOUND_MS

/** A pin without `:` is still a draft — attaching it 400s the den. */
fun isDraftSessionId(sessionId: String): Boolean = ':' !in sessionId

/**
 * After adopt, move the agent's pin from the draft uuid onto the canonical
 * id. No-op when this chat is not the pin (`+ new` must not steal).
 */
fun rekeyPinnedDraft(
    pointers: AgentPointers,
    agentId: String?,
    from: String,
    canonical: String,
    nodeBaseUrl: String,
): Boolean {
    if (agentId.isNullOrBlank() || canonical.isBlank() || canonical == from) return false
    val pin = pointers.get(agentId) ?: return false
    if (pin.sessionId != from && denRoomKey(pin.sessionId) != denRoomKey(from)) return false
    return pointers.set(agentId, canonical, nodeBaseUrl, replace = true)
}

package io.rivethub.app.plane

/**
 * "Needs you" — conversations waiting on the user (a permission prompt or
 * question: the den's `blocked` flag on a session summary / `session-updated`
 * frame). Phone twin of the spaces canvas's dock count, Ctrl+J cycle and
 * needs-you toasts (rivethub-web `components/spaces-canvas/canvas-commands.ts`).
 */

/** A waiting conversation and when it started waiting. */
data class WaitingRow(val id: String, val since: Long)

/**
 * Tracks waiting episodes across registry updates. [since] stamps when each id
 * started waiting; [reconcile] returns the ids that started waiting since the
 * last call. Until [ready] (the first full roster has landed) every call only
 * primes — sessions already waiting at launch are never announced as new.
 */
class NeedsEpisodes {
    private val sinceMs = HashMap<String, Long>()
    private val announced = HashSet<String>()
    private var primed = false

    val since: Map<String, Long> get() = sinceMs

    fun reconcile(blocked: Set<String>, now: Long, ready: Boolean = true): List<String> {
        sinceMs.keys.retainAll(blocked)
        announced.retainAll(blocked)
        for (id in blocked) sinceMs.putIfAbsent(id, now)
        if (!primed || !ready) {
            announced += blocked
            if (ready) primed = true
            return emptyList()
        }
        val fresh = ArrayList<String>()
        for (id in blocked) {
            if (announced.add(id)) fresh += id
        }
        return fresh
    }
}

/** Waiting rows, oldest first (ties by id), stamped from [since] or the row's own [updatedAt]. */
fun waitingRows(items: List<ChatItem>, since: Map<String, Long>): List<WaitingRow> =
    items.filter { it.blocked }
        .map { WaitingRow(it.key, since[it.key] ?: it.sessionId?.let(since::get) ?: it.updatedAt) }
        .sortedWith(compareBy<WaitingRow>({ it.since }, { it.id }))

/**
 * Next waiting conversation to open. In a waiting chat, cycle forward from it
 * (wrapping); anywhere else, the oldest. Null when nothing waits.
 */
fun nextWaitingId(waiting: List<WaitingRow>, currentKey: String?): String? {
    if (waiting.isEmpty()) return null
    val sorted = waiting.sortedWith(compareBy<WaitingRow>({ it.since }, { it.id }))
    if (currentKey == null) return sorted.first().id
    val i = sorted.indexOfFirst { it.id == currentKey || sessionMatchesNative(it.id, currentKey) }
    if (i < 0) return sorted.first().id
    return sorted[(i + 1) % sorted.size].id
}

const val INBOX_KIND_NEEDS_YOU = "needs.you"

/**
 * Post a session notice only with its setting on, and never for the chat
 * already on screen while the app is in front.
 */
fun shouldNotifySession(
    enabled: Boolean,
    appResumed: Boolean,
    sessionId: String,
    openSessionKey: String?,
): Boolean {
    if (!enabled) return false
    if (!appResumed) return true
    if (openSessionKey.isNullOrBlank()) return true
    return !(sessionMatchesNative(sessionId, openSessionKey) || sessionMatchesNative(openSessionKey, sessionId))
}

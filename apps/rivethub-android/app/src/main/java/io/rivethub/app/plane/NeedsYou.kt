package io.rivethub.app.plane

/**
 * "Needs you" — conversations waiting on the user (a permission prompt or
 * question: the den's `blocked` flag on a session summary / `session-updated`
 * frame, or a registry `status: 'blocked'` frame — see [StatusBlocks]). Phone twin of the spaces canvas's dock count, Ctrl+J cycle and
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

    /**
     * [present] = every id currently listed (null: treat [blocked] as the whole
     * world). An id missing from it (its node timed out or a list failed) keeps
     * its episode, so its return is neither re-announced nor re-stamped.
     * [settled] = false for an id whose node has not landed a roster yet: it is
     * primed like the launch roster, never announced.
     */
    fun reconcile(
        blocked: Set<String>,
        now: Long,
        ready: Boolean = true,
        present: Set<String>? = null,
        settled: (String) -> Boolean = { true },
    ): List<String> {
        val ended = { id: String -> id !in blocked && (present == null || id in present) }
        sinceMs.keys.removeAll(ended)
        announced.removeAll(ended)
        for (id in blocked) sinceMs.putIfAbsent(id, now)
        if (!primed || !ready) {
            announced += blocked
            if (ready) primed = true
            return emptyList()
        }
        val fresh = ArrayList<String>()
        for (id in blocked) {
            if (!settled(id)) announced += id
            else if (announced.add(id)) fresh += id
        }
        return fresh
    }

    /** New identity / forget: the next roster primes again. */
    fun clear() {
        sinceMs.clear()
        announced.clear()
        primed = false
    }
}

/**
 * `blocked` carried only by `status` frames on the registry stream — ACP
 * drivers (grok/opencode) report a permission wait as `status: 'blocked'` and
 * never set it on the summary or `session-updated`. Tracked per frame
 * `source`, since one session can hear several (herdr, transcript, protocol):
 * a session stays blocked until every source that said `blocked` has moved on.
 */
class StatusBlocks {
    private val bySession = HashMap<String, HashSet<String>>()

    /** Record a `status` frame; true when the session's blocked state changed. */
    fun onStatus(sessionId: String, status: String, source: String?): Boolean {
        if (sessionId.isBlank()) return false
        val was = isBlocked(sessionId)
        val key = source.orEmpty()
        if (status == "blocked") {
            bySession.getOrPut(sessionId) { HashSet() } += key
        } else {
            bySession[sessionId]?.let { set ->
                set -= key
                if (set.isEmpty()) bySession.remove(sessionId)
            }
        }
        return was != isBlocked(sessionId)
    }

    /** A rekey moves the old id's blocks; an ended session drops them. True on change. */
    fun onSessionUpdated(sessionId: String, status: String, previousSessionId: String? = null): Boolean {
        var changed = false
        if (previousSessionId != null && previousSessionId != sessionId) {
            bySession.remove(previousSessionId)?.let { moved ->
                bySession.getOrPut(sessionId) { HashSet() } += moved
                changed = true
            }
        }
        if (status == "ended" && bySession.remove(sessionId) != null) changed = true
        return changed
    }

    fun isBlocked(sessionId: String): Boolean = bySession[sessionId]?.isNotEmpty() == true

    val isEmpty: Boolean get() = bySession.isEmpty()

    fun clear() = bySession.clear()
}

/** Overlay [blocks] onto [items]: a status-blocked session reads as waiting unless it ended. */
fun withStatusBlocks(items: List<ChatItem>, blocks: StatusBlocks?): List<ChatItem> {
    if (blocks == null || blocks.isEmpty) return items
    return items.map { item ->
        val sid = item.sessionId
        if (!item.blocked && sid != null && item.status != "ended" && blocks.isBlocked(sid)) {
            item.copy(blocked = true)
        } else {
            item
        }
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

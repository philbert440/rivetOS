package io.rivethub.app.plane

/**
 * "Agent finished replying" — the phone twin of rivethub-web
 * `lib/finished-turns.ts`: a notice on each `active` → `idle` edge of a
 * session's registry status. A session seen for the first time never
 * notifies, and an error or end is not a finished reply. A rekey
 * (`previousSessionId`) carries the old id's status to the new one so an
 * adopt mid-turn still produces its edge.
 */
class FinishedTurnTracker {
    private val last = HashMap<String, String>()

    /** Record [status] for [sessionId]; true when this is an active → idle edge. */
    fun onStatus(sessionId: String, status: String, previousSessionId: String? = null): Boolean {
        if (sessionId.isBlank()) return false
        val prev = last[sessionId]
            ?: previousSessionId?.takeIf { it != sessionId }?.let { last.remove(it) }
        last[sessionId] = status
        return prev == STATUS_ACTIVE && status == STATUS_IDLE
    }

    fun clear() = last.clear()

    companion object {
        const val STATUS_ACTIVE = "active"
        const val STATUS_IDLE = "idle"
    }
}

const val INBOX_KIND_AGENT_FINISHED = "agent.finished"

/**
 * Post only with the setting on, and never for the conversation already on
 * screen: with the app in front and that session open, the transcript is the
 * notice. Any other session (or the app in the background) notifies.
 */
fun shouldNotifyAgentFinished(
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

/** Body of the notice: the conversation's title, else its id. */
fun agentFinishedBody(title: String?, sessionId: String): String =
    title?.trim()?.takeIf { it.isNotEmpty() } ?: sessionId

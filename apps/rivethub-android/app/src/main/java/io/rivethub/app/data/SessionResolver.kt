package io.rivethub.app.data

import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * One row in the node's session list. [id]/[lastActive]/[messages] come from
 * `GET /api/sessions`; [name] is overlaid from the den snapshot when the
 * ids match (den `SessionInfo`: id, name, harness?, lastEventTs?).
 */
data class NodeSession(
    val id: String,
    val lastActive: Long = 0,
    val messages: Int = 0,
    val name: String = "",
)

/** Result of first-open adoption. [persist] means write this as the bot override. */
data class SessionPick(val id: String, val persist: Boolean)

/**
 * Pure session-adoption rules shared by Chat and Computer.
 *
 * Override (if set) always wins. Otherwise the most-recently-active row from
 * `GET /api/sessions` is adopted. The minted `defaultSessionId` is only used
 * when the node reported zero sessions (or the fetch failed — then we do
 * not persist, so the next open retries).
 */
object SessionResolver {
    private val stampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")

    fun pick(override: String?, sessions: List<SessionSummary>, minted: String): String {
        val o = override?.trim().orEmpty()
        if (o.isNotEmpty()) return o
        return mostRecent(sessions)?.id ?: minted
    }

    /**
     * @param fetched node list, or null when `/api/sessions` was not reached.
     */
    fun adopt(override: String?, fetched: List<SessionSummary>?, minted: String): SessionPick {
        val o = override?.trim().orEmpty()
        if (o.isNotEmpty()) return SessionPick(o, persist = false)
        if (fetched == null) return SessionPick(minted, persist = false)
        return SessionPick(pick(null, fetched, minted), persist = true)
    }

    /** Same row `merge` would put first: highest lastActive, then lowest id. */
    fun mostRecent(sessions: List<SessionSummary>): SessionSummary? {
        val id = merge(sessions).firstOrNull()?.id ?: return null
        return sessions.first { it.id == id }
    }

    /**
     * `/api/sessions` is the list source (sorted lastActive desc). Den names
     * overlay matching ids; den-only rooms are not added.
     */
    fun merge(api: List<SessionSummary>, den: List<DenSessionInfo> = emptyList()): List<NodeSession> {
        val names = den.associate { it.id to it.name }
        return api
            .filter { it.id.isNotBlank() }
            .map { s ->
                val raw = names[s.id].orEmpty()
                NodeSession(
                    id = s.id,
                    lastActive = s.lastActive,
                    messages = s.messages,
                    name = if (raw.isBlank() || raw == s.id) "" else raw,
                )
            }
            .sortedWith(compareByDescending<NodeSession> { it.lastActive }.thenBy { it.id })
    }

    /** Same shape as [io.rivethub.app.ui.ChatViewModel.newConversation]. */
    fun newSessionId(defaultSessionId: String, stamp: String, rand4: String): String =
        "$defaultSessionId-$stamp-$rand4"

    fun newStamp(now: LocalDateTime = LocalDateTime.now()): String = now.format(stampFmt)
}

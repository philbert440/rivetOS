package io.rivethub.app.plane

import io.rivethub.app.gateway.HARNESS_IDS
import io.rivethub.app.gateway.SessionDeleteResult
import io.rivethub.app.gateway.SessionTrashCandidate
import io.rivethub.app.gateway.nativeIdOf
import java.time.Instant

/**
 * Delete session + clean up (UX-SPEC §2 item 2) — the pure half. Delete
 * removes a session's conversation from the node's memory and drops it from
 * the session list; the harness's own transcript on disk is kept. Everything
 * leans cautious: a row offers Delete only when it maps onto a canonical id
 * on a known node, and a candidate the user renamed is never offered for
 * clean-up.
 */

/**
 * The canonical id the node deletes for [item], or null when the row cannot
 * be deleted:
 *
 * - drafts are local (they keep Discard draft);
 * - a row synthesized from an agent pointer ([ChatItem.pin]) may name a
 *   session the node never listed;
 * - a legacy row whose roster command maps to no harness has no canonical id.
 */
fun deleteTargetFor(item: ChatItem, pointerSessionIds: Collection<String>): String? {
    if (isDraftRow(item, pointerSessionIds) || item.pin) return null
    return when (item.kind) {
        ChatItemKind.DRAFT -> null
        ChatItemKind.HARNESS -> (item.sessionId ?: item.key).takeIf { nativeIdOf(it) != null }
        ChatItemKind.LEGACY -> {
            val harnessId = item.harnessId ?: harnessForRosterCommand(item.command) ?: return null
            if (harnessId !in HARNESS_IDS || item.key.isBlank() || ':' in item.key) return null
            "$harnessId:${item.key}"
        }
    }
}

/** Every key local prefs may hold for [canonical]: the id itself and its native half. */
fun localKeysFor(canonical: String): Set<String> =
    setOfNotNull(canonical, nativeIdOf(canonical))

/** “a”, “b”, “c” then [more] for the rest — the confirm names what it deletes. */
fun quotedList(labels: List<String>, more: (Int) -> String, max: Int = 3): String {
    val shown = labels.take(max).joinToString(", ") { "“$it”" }
    val rest = labels.size - minOf(labels.size, max)
    return if (rest > 0) "$shown ${more(rest)}" else shown
}

enum class DeleteFailure { Live, NotFound, Error }

/** Map a per-item error string onto the cases worded differently. */
fun failureKind(error: String?): DeleteFailure = when (error) {
    "session is live" -> DeleteFailure.Live
    "not found" -> DeleteFailure.NotFound
    else -> DeleteFailure.Error
}

data class FailedDelete(val session: String, val kind: DeleteFailure, val message: String)

data class DeleteOutcome(
    val deleted: List<String> = emptyList(),
    val failed: List<FailedDelete> = emptyList(),
) {
    operator fun plus(other: DeleteOutcome) = DeleteOutcome(deleted + other.deleted, failed + other.failed)
}

/**
 * Fold bulk results into deleted / failed. An id the response does not
 * mention counts as failed: treating silence as success would clear local
 * state for a session that may still exist.
 */
fun foldDeleteResults(requested: List<String>, results: List<SessionDeleteResult>): DeleteOutcome {
    val byId = results.associateBy { it.session }
    val deleted = ArrayList<String>()
    val failed = ArrayList<FailedDelete>()
    for (session in requested) {
        val r = byId[session]
        when {
            r == null -> failed += FailedDelete(session, DeleteFailure.Error, "no result from the gateway")
            r.ok -> deleted += session
            else -> failed += FailedDelete(session, failureKind(r.error), r.error.orEmpty())
        }
    }
    return DeleteOutcome(deleted, failed)
}

/** Every requested id failed the same way (the call itself threw). */
fun failAll(requested: List<String>, kind: DeleteFailure, message: String): DeleteOutcome =
    DeleteOutcome(failed = requested.map { FailedDelete(it, kind, message) })

/**
 * Candidates to show in the clean-up review: drops anything the user renamed
 * (a custom name says they care about it), anything in [exclude] (the open
 * conversation), and malformed rows. Order is the node's.
 */
fun reviewableCandidates(
    candidates: List<SessionTrashCandidate>,
    isRenamed: (String) -> Boolean,
    exclude: Set<String> = emptySet(),
): List<SessionTrashCandidate> = candidates.filter { c ->
    nativeIdOf(c.session) != null &&
        localKeysFor(c.session).none { it in exclude || isRenamed(it) }
}

/** Coarse age for the review list: 5m, 2h, 3d, 5w. Blank when unparsable. */
fun ageLabel(updatedAt: String, nowMs: Long): String {
    val t = runCatching { Instant.parse(updatedAt).toEpochMilli() }.getOrNull() ?: return ""
    val mins = maxOf(0L, Math.round((nowMs - t) / 60_000.0))
    if (mins < 60) return "${mins}m"
    val hours = Math.round(mins / 60.0)
    if (hours < 48) return "${hours}h"
    val days = Math.round(hours / 24.0)
    if (days < 14) return "${days}d"
    return "${Math.round(days / 7.0)}w"
}

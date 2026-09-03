package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessSessionSummary
import io.rivethub.app.gateway.denRoomKey
import java.util.UUID

data class Rekey(val from: String, val to: String)

/** Bare UUID — claude `--session-id` shape. Stays draft until the plane adopts it. */
fun newDraftId(): String = UUID.randomUUID().toString()

/**
 * Adopt a locally tracked draft (or previous canonical) onto the plane
 * summary. Honours `supersedes` lineage the way `adoptSessionKey` honours
 * `previousSessionId`: a canonical predecessor is only retired when the
 * control plane names it. A foreign canonical that merely shares the native
 * half is left alone.
 */
fun adopt(draftId: String, summary: HarnessSessionSummary): Rekey? =
    adoptSessionKey(summary.sessionId, summary.supersedes, listOf(draftId)).firstOrNull()

fun adoptSessionKey(
    canonical: String,
    previous: String?,
    tracked: Collection<String>,
): List<Rekey> {
    val retire = LinkedHashSet<String>()
    if (previous != null && previous != canonical && previous in tracked) {
        retire += previous
    }
    val native = denRoomKey(canonical)
    for (key in tracked) {
        if (key != canonical && key == native) retire += key
    }
    return retire.map { Rekey(it, canonical) }
}

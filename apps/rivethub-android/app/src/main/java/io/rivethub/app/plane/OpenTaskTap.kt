package io.rivethub.app.plane

/**
 * A tapped task-completion notification, read from the Activity intent.
 * [marker] identifies this ONE tap (task id + the nonce the notifier stamped
 * at post time); the Activity keeps the markers it has consumed in its saved
 * state so a recreation re-reading an intent does not re-fire, while a fresh
 * tap — even for the same task — carries a new nonce and opens.
 * [fromLaunch] is true when the tap came from the intent the Activity was
 * CREATED with (read in onCreate), false for an `onNewIntent` delivery.
 */
data class OpenTaskTap(val taskId: String, val marker: String, val fromLaunch: Boolean = false)

/** Recent `onNewIntent` markers kept across recreation; older ones fall off. */
const val CONSUMED_TAPS_MAX = 8

/**
 * The taps the Activity has handled, as saved in its instance state.
 *
 * After process death the system restores the Activity with its ORIGINAL
 * launch intent (extras intact) — never a later `onNewIntent` one. So the
 * consumed launch marker is kept on its own in [launch] for the Activity's
 * whole lifetime and is never evicted, however many later taps pass through
 * the capped [recent] list. That keeps the state bounded (1 + [CONSUMED_TAPS_MAX])
 * while retaining every marker the system can hand back.
 */
data class ConsumedTaps(
    val launch: String? = null,
    val recent: List<String> = emptyList(),
) {
    operator fun contains(marker: String): Boolean = marker == launch || marker in recent
}

fun openTaskMarker(taskId: String, nonce: String?): String = "$taskId#${nonce.orEmpty()}"

/**
 * [extra] is the intent's task id, [nonce] its per-post nonce, and
 * [consumedNonce] the marker of the tap already handled (null when none).
 * Null result → nothing to open.
 */
fun openTaskFromIntent(extra: String?, nonce: String?, consumedNonce: String?): OpenTaskTap? =
    openTaskFromIntent(extra, nonce, listOfNotNull(consumedNonce))

/** Same, against a flat collection of remembered markers. */
fun openTaskFromIntent(extra: String?, nonce: String?, consumed: Collection<String>): OpenTaskTap? {
    val taskId = extra?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val marker = openTaskMarker(taskId, nonce?.trim()?.takeIf { it.isNotEmpty() })
    if (marker in consumed) return null
    return OpenTaskTap(taskId, marker)
}

/**
 * What the Activity calls: against its saved [consumed] taps (the pinned
 * launch marker AND the recent ones). [fromLaunch] — true when reading the
 * intent in onCreate — is carried on the tap so consuming it pins it.
 */
fun openTaskFromIntent(extra: String?, nonce: String?, consumed: ConsumedTaps, fromLaunch: Boolean): OpenTaskTap? {
    val taskId = extra?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val marker = openTaskMarker(taskId, nonce?.trim()?.takeIf { it.isNotEmpty() })
    if (marker in consumed) return null
    return OpenTaskTap(taskId, marker, fromLaunch)
}

/** [consumed] plus [marker], newest last, at most [CONSUMED_TAPS_MAX]. */
fun rememberConsumedTap(consumed: List<String>, marker: String): List<String> =
    (consumed.filter { it != marker } + marker).takeLast(CONSUMED_TAPS_MAX)

/**
 * Record [tap] as handled (or superseded by a newer tap before it was
 * handled — either way it must never fire). A launch tap is pinned in
 * [ConsumedTaps.launch]; any other goes to the capped recent list.
 */
fun rememberConsumedTap(consumed: ConsumedTaps, tap: OpenTaskTap): ConsumedTaps =
    if (tap.fromLaunch) {
        consumed.copy(launch = tap.marker)
    } else {
        consumed.copy(recent = rememberConsumedTap(consumed.recent, tap.marker))
    }

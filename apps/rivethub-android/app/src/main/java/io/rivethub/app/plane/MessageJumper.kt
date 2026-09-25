package io.rivethub.app.plane

/**
 * Message jumper (UX-SPEC §1.2): four stacked round buttons at the trailing
 * edge — top, previous message, next message, bottom — shown for about three
 * seconds after the user scrolls. Not a setting.
 */

/** How long the jumper stays after the user's last scroll went idle. */
const val JUMPER_VISIBLE_MS: Long = 3_000L

/**
 * List indices the jumper scrolls to. [prev]/[next] are null when there is
 * nowhere to go (the button is disabled).
 */
data class JumpTargets(val top: Int, val prev: Int?, val next: Int?, val bottom: Int)

/**
 * Targets for a list of [count] items whose visible window is
 * [firstVisible]..[lastVisible]. Previous/next step between the items in
 * [stops] (the user turns); by default every item is a stop. Previous is the
 * nearest stop above the top of the window; next is the nearest stop below
 * it, and is dropped once the list already shows its last item (it cannot
 * scroll any further down).
 */
fun jumpTargets(
    firstVisible: Int,
    lastVisible: Int,
    count: Int,
    stops: List<Int> = (0 until count).toList(),
): JumpTargets {
    if (count <= 0) return JumpTargets(top = 0, prev = null, next = null, bottom = 0)
    val bottom = count - 1
    val first = firstVisible.coerceIn(0, bottom)
    val atEnd = lastVisible >= bottom
    val inRange = stops.filter { it in 0..bottom }.sorted()
    val prev = inRange.lastOrNull { it < first }
    val next = if (atEnd) null else inRange.firstOrNull { it > first }
    return JumpTargets(top = 0, prev = prev, next = next, bottom = bottom)
}

/**
 * Whether the jumper shows: only after a user scroll, until
 * [JUMPER_VISIBLE_MS] after the moment [idleMs] that scroll went idle (a
 * scroll still in progress passes `idleMs = now`).
 */
fun jumperVisible(userScrolled: Boolean, idleMs: Long, now: Long): Boolean =
    userScrolled && now >= idleMs && now - idleMs < JUMPER_VISIBLE_MS

/** Delay until the jumper should hide again (0 when it already has). */
fun jumperHideDelayMs(idleMs: Long, now: Long): Long =
    (JUMPER_VISIBLE_MS - (now - idleMs)).coerceIn(0L, JUMPER_VISIBLE_MS)

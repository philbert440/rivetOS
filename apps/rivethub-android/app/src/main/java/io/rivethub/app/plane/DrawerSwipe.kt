package io.rivethub.app.plane

import kotlin.math.abs

/**
 * Edge-swipe geometry for the ONE left drawer (drawer v2, UX-SPEC §2: there
 * is no right drawer — the conversation list lives in the left one). The
 * drawer host (`ui/components/RivetDrawerHost.kt`) runs one gesture layer
 * that evaluates these pure functions: a drag that [claimsDrawerDrag] moves
 * the sheet with the finger, and [settlesOpen] picks where it lands when the
 * finger lifts, as Android's own navigation drawers do.
 *
 * All geometry inputs are in the SAME unit (the UI layer passes px converted
 * from the dp constants here).
 */

/** Smallest edge zone, used as-is on 3-button navigation (no gesture inset). */
const val EDGE_ZONE_DP = 24

/**
 * How far the zone reaches past the system Back-gesture inset. With gesture
 * navigation Android claims a strip along the bezel for Back; a swipe that
 * starts just inside that strip still reaches the app.
 */
const val EDGE_ZONE_PAST_INSET_DP = 24

/**
 * Height of the bezel band excluded from the system Back gesture while the
 * drawer is closed, so a swipe from the very edge opens the drawer there.
 * Android honours at most 200dp of exclusion per edge.
 */
const val EDGE_EXCLUSION_HEIGHT_DP = 200

/** Lift speed (dp/s) above which the fling direction wins over position. */
const val DRAWER_FLING_DP_PER_S = 400

/**
 * The left edge zone: at least [EDGE_ZONE_DP]. With [reachPastInset] (hub home,
 * where a mid-bezel band is also excluded from Back) it reaches [pastInset]
 * beyond the Back-gesture inset. Elsewhere (chat / terminal) it stays
 * `max(minZone, inset)` so a rightward drag on a scrollable child near the
 * bezel is less likely to open the drawer.
 */
fun drawerEdgeZone(
    systemGestureInset: Float,
    minZone: Float = EDGE_ZONE_DP.toFloat(),
    pastInset: Float = EDGE_ZONE_PAST_INSET_DP.toFloat(),
    reachPastInset: Boolean = true,
): Float = when {
    systemGestureInset <= 0f -> minZone
    reachPastInset -> maxOf(minZone, systemGestureInset + pastInset)
    else -> maxOf(minZone, systemGestureInset)
}

/**
 * Whether a gesture-so-far takes the drawer.
 *
 * Rules:
 *  - [childConsumed]: a scrollable under the down already took this move → no
 *    (code blocks / key toolbar near the bezel keep their horizontal drag).
 *  - Not past [slop], or not horizontal-dominant (`|dx| <= |dy|`) → no (a
 *    vertical scroll starting at the bezel must not yank the drawer).
 *  - Closed: the drag starts within [zone] of the LEFT bezel and heads right.
 *  - Open: the drag STARTS ON THE SCRIM (`startX >` [sheetWidth], right of the
 *    open sheet) and heads left. A drag that starts on the sheet is left to
 *    the sheet itself, so rows keep their own horizontal gestures (the
 *    conversation row's swipe-to-archive); the sheet closes on a drag only
 *    where nothing inside it took the gesture.
 */
fun claimsDrawerDrag(
    startX: Float,
    dx: Float,
    dy: Float,
    open: Boolean,
    sheetWidth: Float,
    zone: Float,
    slop: Float,
    childConsumed: Boolean = false,
): Boolean {
    if (childConsumed) return false
    if (abs(dx) < slop || abs(dx) <= abs(dy)) return false
    return if (open) startX > sheetWidth && dx < 0f else startX <= zone && dx > 0f
}

/**
 * Where a released drag lands. [fraction] is how far open the sheet is
 * (0 closed … 1 open); [velocity] is the lift speed, positive toward open.
 * A fling at or above [flingThreshold] goes its way; otherwise the nearer end
 * wins, half-open opening.
 */
fun settlesOpen(fraction: Float, velocity: Float, flingThreshold: Float): Boolean =
    if (abs(velocity) >= flingThreshold) velocity > 0f else fraction >= 0.5f

/**
 * Where a claimed drag puts the sheet: [startFraction] plus the finger's
 * travel since the claim. [dx] is measured from the down position, and the
 * claim happens [slop] past it, so the slop is taken off (toward the drag's
 * direction) to keep the sheet from jumping by that distance.
 */
fun drawerDragFraction(startFraction: Float, dx: Float, slop: Float, startOpen: Boolean, sheetWidth: Float): Float {
    val travel = if (startOpen) dx + slop else dx - slop
    return (startFraction + travel / sheetWidth).coerceIn(0f, 1f)
}

/**
 * How open the sheet stays while a predictive Back gesture is in flight:
 * it eases shut by up to [PREDICTIVE_BACK_TRAVEL] of [from] (how open it was
 * when the gesture started) with the gesture's [progress] (0…1), then closes
 * on commit or springs back on cancel.
 */
fun predictiveBackFraction(progress: Float, from: Float = 1f): Float =
    from * (1f - PREDICTIVE_BACK_TRAVEL * progress.coerceIn(0f, 1f))

const val PREDICTIVE_BACK_TRAVEL = 0.35f

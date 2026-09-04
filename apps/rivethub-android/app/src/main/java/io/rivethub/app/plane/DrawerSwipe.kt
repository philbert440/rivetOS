package io.rivethub.app.plane

import kotlin.math.abs

/**
 * Unified edge-swipe decision for the TWO nested modal drawers (2026-09-04:
 * the nested drawers' built-in gestures competed, so the left swipe lost
 * arbitration and neither drawer reliably closed by swipe). Both drawers now
 * run `gesturesEnabled = false` and ONE gesture layer on the shared ancestor
 * evaluates this pure function per move, mirroring the web
 * `lib/edge-swipe.ts` semantics (edge zone + horizontal-dominant + travel
 * threshold, fires once per gesture).
 *
 * All geometry inputs are in the SAME unit (the UI layer passes px converted
 * from [EDGE_ZONE_DP] / [EDGE_TRAVEL_DP]).
 */
const val EDGE_ZONE_DP = 20
const val EDGE_TRAVEL_DP = 40

enum class DrawerSide { Left, Right }

sealed interface DrawerSwipeAction {
    val side: DrawerSide

    data class Open(override val side: DrawerSide) : DrawerSwipeAction
    data class Close(override val side: DrawerSide) : DrawerSwipeAction
}

/**
 * Which drawer action (if any) a gesture-so-far implies.
 *
 * Rules:
 *  - Not horizontal-dominant (`|dx| <= |dy|`) → nothing (a vertical scroll
 *    starting at the bezel must not yank a drawer).
 *  - The LEFT drawer is open and the drag travels left ≥ [travel] → close it.
 *  - The RIGHT drawer is open and the drag travels right ≥ [travel] → close it.
 *  - Neither open: start within [zone] of the LEFT bezel and dx ≥ [travel] →
 *    open the left drawer.
 *  - Neither open: [sessionOpen] AND start within [zone] of the RIGHT bezel
 *    and -dx ≥ [travel] → open the right (history) drawer. The right bezel is
 *    inert outside a session.
 */
fun decideDrawerSwipe(
    startX: Float,
    dx: Float,
    dy: Float,
    viewportWidth: Float,
    sessionOpen: Boolean,
    leftOpen: Boolean,
    rightOpen: Boolean,
    zone: Float = EDGE_ZONE_DP.toFloat(),
    travel: Float = EDGE_TRAVEL_DP.toFloat(),
): DrawerSwipeAction? {
    if (abs(dx) <= abs(dy)) return null
    if (leftOpen) {
        return if (-dx >= travel) DrawerSwipeAction.Close(DrawerSide.Left) else null
    }
    if (rightOpen) {
        return if (dx >= travel) DrawerSwipeAction.Close(DrawerSide.Right) else null
    }
    if (startX <= zone && dx >= travel) return DrawerSwipeAction.Open(DrawerSide.Left)
    if (sessionOpen && startX >= viewportWidth - zone && -dx >= travel) {
        return DrawerSwipeAction.Open(DrawerSide.Right)
    }
    return null
}

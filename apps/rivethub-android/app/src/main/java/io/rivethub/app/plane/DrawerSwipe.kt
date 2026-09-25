package io.rivethub.app.plane

import kotlin.math.abs

/**
 * Edge-swipe decision for the ONE left modal drawer (drawer v2, UX-SPEC §2:
 * there is no right drawer — the conversation list lives in the left one).
 * The drawer runs `gesturesEnabled = false` and one gesture layer on its host
 * evaluates this pure function per move, mirroring the web
 * `lib/edge-swipe.ts` semantics (edge zone + horizontal-dominant + travel
 * threshold, fires once per gesture). 2026-09-04 history: the built-in
 * drawer gesture lost arbitration when two drawers were nested, which is why
 * the gesture is owned here rather than by `ModalNavigationDrawer`.
 *
 * All geometry inputs are in the SAME unit (the UI layer passes px converted
 * from [EDGE_ZONE_DP] / [EDGE_TRAVEL_DP]).
 */
const val EDGE_ZONE_DP = 20
const val EDGE_TRAVEL_DP = 40

/** Only the left side exists since drawer v2; kept as a type so actions stay self-describing. */
enum class DrawerSide { Left }

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
 *    starting at the bezel must not yank the drawer).
 *  - The drawer is open, the drag STARTS ON THE SCRIM (`startX >`
 *    [sheetWidth], i.e. right of the open sheet) and travels left ≥ [travel]
 *    → close it. A drag that starts on the sheet itself returns nothing, so
 *    the rows inside it keep their own horizontal gestures (the conversation
 *    row's swipe-to-archive, fix1 — a sheet-wide close used to steal it).
 *    The scrim tap, the header close button and Back still close from there.
 *  - The drawer is closed: start within [zone] of the LEFT bezel and
 *    dx ≥ [travel] → open it.
 *  - The right bezel is inert everywhere (no right drawer).
 */
fun decideDrawerSwipe(
    startX: Float,
    dx: Float,
    dy: Float,
    leftOpen: Boolean,
    sheetWidth: Float,
    zone: Float = EDGE_ZONE_DP.toFloat(),
    travel: Float = EDGE_TRAVEL_DP.toFloat(),
): DrawerSwipeAction? {
    if (abs(dx) <= abs(dy)) return null
    if (leftOpen) {
        return if (startX > sheetWidth && -dx >= travel) DrawerSwipeAction.Close(DrawerSide.Left) else null
    }
    if (startX <= zone && dx >= travel) return DrawerSwipeAction.Open(DrawerSide.Left)
    return null
}

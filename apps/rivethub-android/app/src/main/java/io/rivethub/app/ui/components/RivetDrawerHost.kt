package io.rivethub.app.ui.components

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.foundation.MutatorMutex
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemGestures
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.DRAWER_FLING_DP_PER_S
import io.rivethub.app.plane.EDGE_EXCLUSION_HEIGHT_DP
import io.rivethub.app.plane.EDGE_ZONE_DP
import io.rivethub.app.plane.EDGE_ZONE_PAST_INSET_DP
import io.rivethub.app.plane.claimsDrawerDrag
import io.rivethub.app.plane.drawerDragFraction
import io.rivethub.app.plane.drawerEdgeZone
import io.rivethub.app.plane.settlesOpen
import kotlin.math.abs
import kotlinx.coroutines.launch

/**
 * How far open the left drawer is: [fraction] 0 (closed) … 1 (open), moved
 * directly by a finger and animated by [open] / [close] / [settle].
 * [targetOpen] is where it is headed — it flips as soon as an opening drag
 * starts, so the drawer body can scroll its open row into view while the
 * sheet is still sliding in.
 */
@Stable
class RivetDrawerState {
    var fraction by mutableFloatStateOf(0f)
        private set
    var targetOpen by mutableStateOf(false)
        private set

    /**
     * Visible at all, or on its way open. Back closes it in either case.
     * Derived, so readers recompose when it flips, not on every frame.
     */
    val isOpen: Boolean by derivedStateOf { targetOpen || fraction > 0f }

    /** One owner at a time: a new drag, settle or peek cancels the running one. */
    private val mutex = MutatorMutex()

    suspend fun open() = settle(open = true)
    suspend fun close() = settle(open = false)

    /** Animate to open or closed, carrying a lift [velocity] in fraction/s. */
    suspend fun settle(open: Boolean, velocity: Float = 0f) = mutex.mutate {
        targetOpen = open
        animate(
            initialValue = fraction,
            targetValue = if (open) 1f else 0f,
            initialVelocity = velocity,
            animationSpec = spring(stiffness = 700f),
        ) { value, _ -> fraction = value }
    }

    /** Follow a finger (cancels any running animation). */
    suspend fun dragTo(value: Float) = mutex.mutate {
        val v = value.coerceIn(0f, 1f)
        if (v > fraction) targetOpen = true
        fraction = v
    }

    /** Move by a finger delta, as a fraction of the sheet width. */
    suspend fun dragBy(delta: Float) = mutex.mutate {
        fraction = (fraction + delta).coerceIn(0f, 1f)
    }

    /** Hold a predictive-Back position without changing where the drawer is headed. */
    suspend fun peek(value: Float) = mutex.mutate {
        fraction = value.coerceIn(0f, 1f)
    }
}

/**
 * The phone's left navigation drawer, built to Android's drawer gestures:
 *
 *  - A swipe from the left edge pulls the sheet out under the finger and
 *    lands open or closed by fling speed, else by how far it got
 *    (`plane/DrawerSwipe.kt`). The edge zone reaches past the system Back
 *    gesture's inset, so under gesture navigation a swipe that starts just
 *    inside the screen opens it. With [excludeBackGesture] (the hub home,
 *    where Back has nothing in the app to return to) a
 *    [EDGE_EXCLUSION_HEIGHT_DP]-tall band of the bezel is also excluded from
 *    the Back gesture while the drawer is closed, so a swipe from the very
 *    edge opens it there. Elsewhere (a chat, its terminal) the bezel stays Back.
 *  - A drag that is interrupted (pointer lost, the gesture layer restarted on
 *    a rotation or inset change) still settles, so the sheet never stays
 *    half-open.
 *  - An open sheet follows a leftward drag started on the scrim, or on any
 *    part of the sheet whose content did not take the drag (rows keep
 *    swipe-to-archive), and a scrim tap closes it.
 *  - Predictive Back is the host's job (`HubDrawer`), through [RivetDrawerState.peek].
 *
 * The drawer body stays composed while closed (list scroll and state
 * survive) but sits off-screen and out of the accessibility tree.
 */
@Composable
fun RivetDrawerHost(
    state: RivetDrawerState,
    sheetWidth: Dp,
    scrimColor: Color,
    excludeBackGesture: Boolean,
    drawerContent: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val layoutDirection = LocalLayoutDirection.current
    val slop = LocalViewConfiguration.current.touchSlop
    val gestureInset = WindowInsets.systemGestures.getLeft(density, layoutDirection).toFloat()
    val sheetPx = with(density) { sheetWidth.toPx() }
    val zone = with(density) {
        drawerEdgeZone(gestureInset, EDGE_ZONE_DP.dp.toPx(), EDGE_ZONE_PAST_INSET_DP.dp.toPx())
    }
    val fling = with(density) { DRAWER_FLING_DP_PER_S.dp.toPx() }
    val exclusionHeight = with(density) { EDGE_EXCLUSION_HEIGHT_DP.dp.toPx() }
    val visible by remember(state) { derivedStateOf { state.fraction > 0f } }
    val closeMenu = stringResource(R.string.cd_close_drawer)
    val menuTitle = stringResource(R.string.drawer_pane_title)

    Box(
        Modifier
            .fillMaxSize()
            // Keep the bezel's middle band for the drawer while it is closed
            // (gesture navigation would otherwise take every edge swipe as
            // Back). Added and removed with the state: the rect is only
            // recomputed on layout, so an always-on modifier would go stale.
            .then(
                if (state.isOpen || !excludeBackGesture) {
                    Modifier
                } else {
                    Modifier.systemGestureExclusion { coords ->
                        val h = coords.size.height.toFloat()
                        val top = ((h - exclusionHeight) / 2f).coerceAtLeast(0f)
                        Rect(0f, top, zone, (top + exclusionHeight).coerceAtMost(h))
                    }
                },
            )
            .pointerInput(state, sheetPx, zone, slop) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val startOpen = state.isOpen
                    val startFraction = state.fraction
                    var claimed = false
                    var settled = false
                    val tracker = VelocityTracker()
                    try {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            val dx = change.position.x - down.position.x
                            if (!change.pressed) {
                                if (claimed) {
                                    val v = tracker.calculateVelocity().x
                                    settled = true
                                    scope.launch {
                                        state.settle(settlesOpen(state.fraction, v, fling), v / sheetPx)
                                    }
                                }
                                break
                            }
                            if (!claimed) {
                                claimed = claimsDrawerDrag(
                                    startX = down.position.x,
                                    dx = dx,
                                    dy = change.position.y - down.position.y,
                                    open = startOpen,
                                    sheetWidth = sheetPx,
                                    zone = zone,
                                    slop = slop,
                                )
                                if (!claimed) {
                                    // Past the slop without claiming: a scroll or
                                    // a row's own swipe, not ours.
                                    val dy = change.position.y - down.position.y
                                    if (abs(dx) >= slop || abs(dy) >= slop) break
                                    continue
                                }
                            }
                            tracker.addPosition(change.uptimeMillis, change.position)
                            change.consume()
                            val to = drawerDragFraction(startFraction, dx, slop, startOpen, sheetPx)
                            scope.launch { state.dragTo(to) }
                        }
                    } finally {
                        // The pointer vanished or this gesture layer was
                        // restarted mid-drag: land by position.
                        if (claimed && !settled) {
                            scope.launch { state.settle(settlesOpen(state.fraction, 0f, fling)) }
                        }
                    }
                }
            },
    ) {
        content()
        if (visible) {
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer { alpha = state.fraction }
                    .background(scrimColor)
                    .semantics {
                        contentDescription = closeMenu
                        onClick {
                            scope.launch { state.close() }
                            true
                        }
                    }
                    .pointerInput(state) { detectTapGestures { scope.launch { state.close() } } },
            )
        }
        Box(
            Modifier
                .width(sheetWidth)
                .fillMaxHeight()
                .graphicsLayer { translationX = -(1f - state.fraction) * sheetPx }
                .draggable(
                    state = rememberDraggableState { delta -> scope.launch { state.dragBy(delta / sheetPx) } },
                    orientation = Orientation.Horizontal,
                    enabled = visible,
                    onDragStopped = { v ->
                        state.settle(settlesOpen(state.fraction, v, fling), v / sheetPx)
                    },
                )
                .then(
                    if (visible) Modifier.semantics { paneTitle = menuTitle } else Modifier.clearAndSetSemantics { },
                ),
        ) {
            drawerContent()
        }
    }
}

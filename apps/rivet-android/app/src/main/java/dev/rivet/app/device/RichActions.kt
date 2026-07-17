package dev.rivet.app.device

import org.json.JSONArray
import org.json.JSONObject

// ---------------------------------------------------------------------------
// Pure rich-action helpers (JVM-testable; no Android framework)
// ---------------------------------------------------------------------------

/** Minimum hold for coordinate long_press strokes (ms). */
const val LONG_PRESS_MIN_DURATION_MS = 600L

/** Default single-tap stroke length inside a double_tap (ms). */
const val DOUBLE_TAP_STROKE_MS = 50L

/** Delay from start of first tap to start of second tap (ms). */
const val DOUBLE_TAP_GAP_MS = 100L

/** Default drag / scroll-swipe duration when client omits durationMs. */
const val DRAG_DEFAULT_DURATION_MS = 300L
const val SCROLL_SWIPE_DEFAULT_DURATION_MS = 300L

/** Fraction of node/screen dimension used as swipe travel for scroll fallback. */
const val SCROLL_SWIPE_SPAN_FRACTION = 0.45f

/** Minimum swipe travel in px so tiny nodes still move content. */
const val SCROLL_SWIPE_MIN_SPAN_PX = 80

// AccessibilityNodeInfo.ACTION_* integer ids (stable framework constants).
const val A11Y_ACTION_FOCUS = 0x00000001
const val A11Y_ACTION_SELECT = 0x00000004
const val A11Y_ACTION_CLICK = 0x00000010
const val A11Y_ACTION_LONG_CLICK = 0x00000020
const val A11Y_ACTION_SCROLL_FORWARD = 0x00001000
const val A11Y_ACTION_SCROLL_BACKWARD = 0x00002000
const val A11Y_ACTION_SET_TEXT = 0x00200000

/** Supported `node_action.action` wire names (order stable for /status). */
val NODE_ACTION_NAMES: List<String> = listOf(
    "click",
    "long_click",
    "focus",
    "set_text",
    "scroll_forward",
    "scroll_backward",
    "select",
)

/**
 * Map a `node_action` action name to the corresponding AccessibilityNodeInfo action id.
 * Unknown → null (caller returns 400 bad_request).
 */
fun mapNodeActionNameToActionId(action: String): Int? = when (action.lowercase()) {
    "click" -> A11Y_ACTION_CLICK
    "long_click" -> A11Y_ACTION_LONG_CLICK
    "focus" -> A11Y_ACTION_FOCUS
    "set_text" -> A11Y_ACTION_SET_TEXT
    "scroll_forward" -> A11Y_ACTION_SCROLL_FORWARD
    "scroll_backward" -> A11Y_ACTION_SCROLL_BACKWARD
    "select" -> A11Y_ACTION_SELECT
    else -> null
}

/** True when the action requires a `text` body field. */
fun nodeActionRequiresText(action: String): Boolean =
    action.lowercase() == "set_text"

enum class ScrollDirection {
    UP,
    DOWN,
    LEFT,
    RIGHT,
    ;

    val wire: String get() = name.lowercase()

    companion object {
        fun parse(s: String?): ScrollDirection? = when (s?.lowercase()) {
            "up" -> UP
            "down" -> DOWN
            "left" -> LEFT
            "right" -> RIGHT
            else -> null
        }
    }
}

/**
 * Map scroll direction to ACTION_SCROLL_FORWARD vs BACKWARD fallback.
 * DOWN/RIGHT → forward; UP/LEFT → backward (standard a11y list semantics).
 */
fun scrollDirectionToForwardBackward(direction: ScrollDirection): Int = when (direction) {
    ScrollDirection.DOWN, ScrollDirection.RIGHT -> A11Y_ACTION_SCROLL_FORWARD
    ScrollDirection.UP, ScrollDirection.LEFT -> A11Y_ACTION_SCROLL_BACKWARD
}

/**
 * Clamp coordinate long_press duration to at least [LONG_PRESS_MIN_DURATION_MS].
 * Null/missing/non-positive → default minimum.
 */
fun longPressDurationMs(requested: Long?): Long {
    val raw = requested ?: LONG_PRESS_MIN_DURATION_MS
    return raw.coerceAtLeast(LONG_PRESS_MIN_DURATION_MS)
}

/**
 * Build SET_TEXT payload for `text` action modes.
 * - replace (default): [text] only
 * - append: [currentFieldText] + [text]
 */
fun resolveTextPayload(mode: String, currentFieldText: String, text: String): String =
    when (mode.lowercase()) {
        "append" -> currentFieldText + text
        else -> text
    }

/** Parse text mode; only replace|append accepted. Null/blank → replace. */
fun parseTextMode(raw: String?): String? {
    if (raw.isNullOrBlank()) return "replace"
    return when (raw.lowercase()) {
        "replace", "append" -> raw.lowercase()
        else -> null
    }
}

/** Axis-aligned swipe segment for scroll coordinate fallback. */
data class ScrollSwipeSegment(
    val x1: Int,
    val y1: Int,
    val x2: Int,
    val y2: Int,
)

/**
 * Finger path for a scroll direction around a center point.
 *
 * Finger moves opposite content motion (e.g. direction=down → finger swipes up
 * so list content advances downward).
 */
fun scrollDirectionToSwipe(
    direction: ScrollDirection,
    centerX: Int,
    centerY: Int,
    spanPx: Int,
): ScrollSwipeSegment {
    val span = spanPx.coerceAtLeast(SCROLL_SWIPE_MIN_SPAN_PX)
    val half = span / 2
    return when (direction) {
        // Finger up → content moves down
        ScrollDirection.DOWN -> ScrollSwipeSegment(
            x1 = centerX,
            y1 = centerY + half,
            x2 = centerX,
            y2 = centerY - half,
        )
        // Finger down → content moves up
        ScrollDirection.UP -> ScrollSwipeSegment(
            x1 = centerX,
            y1 = centerY - half,
            x2 = centerX,
            y2 = centerY + half,
        )
        // Finger left → content moves right
        ScrollDirection.RIGHT -> ScrollSwipeSegment(
            x1 = centerX + half,
            y1 = centerY,
            x2 = centerX - half,
            y2 = centerY,
        )
        // Finger right → content moves left
        ScrollDirection.LEFT -> ScrollSwipeSegment(
            x1 = centerX - half,
            y1 = centerY,
            x2 = centerX + half,
            y2 = centerY,
        )
    }
}

/** Span length from bounds size (max of width/height × fraction, min floor). */
fun scrollSpanFromBounds(width: Int, height: Int): Int {
    val base = maxOf(width, height)
    val span = (base * SCROLL_SWIPE_SPAN_FRACTION).toInt()
    return span.coerceAtLeast(SCROLL_SWIPE_MIN_SPAN_PX)
}

// ---------------------------------------------------------------------------
// Generalized node_action outcomes + HTTP envelope
// ---------------------------------------------------------------------------

/**
 * Result of a resolved node action (click + richer performAction paths).
 * Gesture fallback is used for click / long_click when performAction returns false.
 */
sealed class NodeActionOutcome {
    /** performAction returned true (no gesture). */
    data class PerformOk(val durationMs: Long = 0L) : NodeActionOutcome()

    /** performAction false; coordinate gesture was attempted. */
    data class GestureFallback(val outcome: GestureAwaitOutcome) : NodeActionOutcome()

    data object StaleNode : NodeActionOutcome()
    data object A11yDisconnected : NodeActionOutcome()

    /** performAction false and no usable gesture fallback. */
    data object ActionFailed : NodeActionOutcome()
}

/** Convert legacy click-only outcome (tests / nodeClick) into [NodeActionOutcome]. */
fun NodeClickOutcome.toNodeActionOutcome(): NodeActionOutcome = when (this) {
    is NodeClickOutcome.PerformClickOk -> NodeActionOutcome.PerformOk(durationMs)
    is NodeClickOutcome.GestureFallback -> NodeActionOutcome.GestureFallback(outcome)
    is NodeClickOutcome.StaleNode -> NodeActionOutcome.StaleNode
    is NodeClickOutcome.A11yDisconnected -> NodeActionOutcome.A11yDisconnected
    is NodeClickOutcome.ClickFailed -> NodeActionOutcome.ActionFailed
}

/**
 * Map [NodeActionOutcome] to the action envelope with `type: node_action` (or override).
 *
 * @param responseType JSON `type` field; default `node_action`. Use `long_press` when
 *   the top-level action type was long_press with nodeId.
 */
fun mapNodeActionToHttp(
    nodeId: String,
    action: String,
    outcome: NodeActionOutcome,
    executedAt: Long = System.currentTimeMillis(),
    responseType: String = "node_action",
): HttpResponse {
    when (outcome) {
        is NodeActionOutcome.StaleNode -> {
            return errorResponse(
                code = 400,
                error = "stale_node",
                message = "nodeId expired or failed re-resolve; re-dump /ui and retry",
            )
        }
        is NodeActionOutcome.A11yDisconnected -> {
            return errorResponse(
                code = 503,
                error = "a11y_disconnected",
                message = "accessibility service not connected — enable it in Settings",
            )
        }
        is NodeActionOutcome.ActionFailed -> {
            val body = JSONObject()
                .put("ok", false)
                .put("type", responseType)
                .put("nodeId", nodeId)
                .put("action", action)
                .put("completed", false)
                .put("durationMs", 0L)
                .put("executed_at", executedAt)
                .put("error", "action_failed")
            return jsonResponse(200, body)
        }
        is NodeActionOutcome.PerformOk -> {
            val body = JSONObject()
                .put("ok", true)
                .put("type", responseType)
                .put("nodeId", nodeId)
                .put("action", action)
                .put("completed", true)
                .put("durationMs", outcome.durationMs)
                .put("executed_at", executedAt)
            return jsonResponse(200, body)
        }
        is NodeActionOutcome.GestureFallback -> {
            when (val g = outcome.outcome) {
                is GestureAwaitOutcome.Busy -> {
                    return errorResponse(
                        code = 429,
                        error = "busy",
                        message = "gesture_busy",
                    )
                }
                is GestureAwaitOutcome.Done -> {
                    val r = g.result
                    val ok = r.completed
                    val body = JSONObject()
                        .put("ok", ok)
                        .put("accepted", r.accepted)
                        .put("completed", r.completed)
                        .put("cancelled", r.cancelled)
                        .put("timedOut", r.timedOut)
                        .put("type", responseType)
                        .put("nodeId", nodeId)
                        .put("action", action)
                        .put("durationMs", r.durationMs)
                        .put("executed_at", executedAt)
                    if (!ok) {
                        when {
                            r.cancelled -> body.put("error", "action_failed")
                            r.timedOut -> body.put("error", "timed_out")
                            !r.accepted -> body.put("error", "action_failed")
                            else -> body.put("error", "action_failed")
                        }
                    }
                    return jsonResponse(200, body)
                }
            }
        }
    }
}

/** Clipboard get/set success envelopes (pure JSON builders). */
fun clipboardGetResponse(text: String, executedAt: Long = System.currentTimeMillis()): HttpResponse {
    val body = JSONObject()
        .put("ok", true)
        .put("type", "clipboard")
        .put("op", "get")
        .put("text", text)
        .put("executed_at", executedAt)
    return jsonResponse(200, body)
}

fun clipboardSetResponse(executedAt: Long = System.currentTimeMillis()): HttpResponse {
    val body = JSONObject()
        .put("ok", true)
        .put("type", "clipboard")
        .put("op", "set")
        .put("executed_at", executedAt)
    return jsonResponse(200, body)
}

/** Build `node_actions` JSONArray for /status capabilities. */
fun nodeActionsCapabilityArray(): JSONArray {
    val arr = JSONArray()
    for (name in NODE_ACTION_NAMES) arr.put(name)
    return arr
}

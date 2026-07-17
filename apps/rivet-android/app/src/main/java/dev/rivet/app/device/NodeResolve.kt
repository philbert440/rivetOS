package dev.rivet.app.device

import org.json.JSONObject
import kotlin.math.sqrt

// ---------------------------------------------------------------------------
// Per-dump node index + pure resolve (JVM-testable; no Android framework)
// ---------------------------------------------------------------------------

/** Axis-aligned bounds in screen pixels (pure stand-in for android.graphics.Rect). */
data class NodeBounds(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
) {
    val width: Int get() = (right - left).coerceAtLeast(0)
    val height: Int get() = (bottom - top).coerceAtLeast(0)
    val centerX: Int get() = left + width / 2
    val centerY: Int get() = top + height / 2
    val isEmpty: Boolean get() = width <= 0 || height <= 0
}

/**
 * Snapshot of one a11y node from a dump, keyed by per-dump [id] (`n0`…`nN`).
 * [path] is child indices from the active-window root (empty for the root itself).
 */
data class NodeRef(
    val id: String,
    val path: IntArray,
    val className: String,
    val viewId: String,
    val text: String,
    val contentDescription: String,
    val packageName: String,
    val boundsCenterX: Int,
    val boundsCenterY: Int,
    val bounds: NodeBounds,
) {
    /** Path as `"0/2/1"`; empty string for the root. */
    fun pathString(): String = path.joinToString("/")

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is NodeRef) return false
        return id == other.id &&
            path.contentEquals(other.path) &&
            className == other.className &&
            viewId == other.viewId &&
            text == other.text &&
            contentDescription == other.contentDescription &&
            packageName == other.packageName &&
            boundsCenterX == other.boundsCenterX &&
            boundsCenterY == other.boundsCenterY &&
            bounds == other.bounds
    }

    override fun hashCode(): Int {
        var result = id.hashCode()
        result = 31 * result + path.contentHashCode()
        result = 31 * result + className.hashCode()
        result = 31 * result + viewId.hashCode()
        result = 31 * result + text.hashCode()
        result = 31 * result + contentDescription.hashCode()
        result = 31 * result + packageName.hashCode()
        result = 31 * result + boundsCenterX
        result = 31 * result + boundsCenterY
        result = 31 * result + bounds.hashCode()
        return result
    }
}

data class NodeIndex(
    val dumpId: Long,
    val createdElapsedMs: Long,
    val ttlMs: Long = NODE_INDEX_TTL_MS,
    val byId: Map<String, NodeRef>,
)

const val NODE_INDEX_TTL_MS = 15_000L
const val NODE_HARD_CAP = 500
/** Euclidean px tolerance for Compose unlabeled identity (class already matched). */
const val COMPOSE_BOUNDS_MATCH_PX = 48

/**
 * Lightweight tree node for pure resolve / dump tests.
 * Implementations must not require the Android framework.
 */
interface ResolvableNode {
    val childCount: Int
    fun getChild(i: Int): ResolvableNode?
    val className: String
    val viewId: String
    val text: String
    val contentDescription: String
    val packageName: String
    val bounds: NodeBounds
    val boundsCenterX: Int get() = bounds.centerX
    val boundsCenterY: Int get() = bounds.centerY
}

/** Outcome of the pure Resolve(nodeId) algorithm (steps 1–6). */
sealed class ResolveResult {
    /** Path walk + identity accepted; [node] is the live tree node at the path. */
    data class Accept(val node: ResolvableNode, val ref: NodeRef) : ResolveResult()
    data object StaleNode : ResolveResult()
    data object A11yDisconnected : ResolveResult()
}

/**
 * Normative Resolve(nodeId):
 * 1. null index or TTL expired → stale_node
 * 2. missing id → stale_node
 * 3. null root → a11y_disconnected
 * 4. path walk; null child → stale_node
 * 5–6. identity accept / fail → accept or stale_node
 *
 * Does not recycle anything (caller's responsibility for framework nodes).
 */
fun resolveNode(
    index: NodeIndex?,
    nodeId: String,
    nowElapsedMs: Long,
    root: ResolvableNode?,
): ResolveResult {
    if (index == null) return ResolveResult.StaleNode
    if (nowElapsedMs - index.createdElapsedMs > index.ttlMs) return ResolveResult.StaleNode
    val ref = index.byId[nodeId] ?: return ResolveResult.StaleNode
    if (root == null) return ResolveResult.A11yDisconnected

    var current: ResolvableNode = root
    for (childIndex in ref.path) {
        val child = current.getChild(childIndex) ?: return ResolveResult.StaleNode
        current = child
    }

    return if (identityAccepts(ref, current)) {
        ResolveResult.Accept(current, ref)
    } else {
        ResolveResult.StaleNode
    }
}

/**
 * Identity accept after path walk (class must match always).
 * - non-empty viewId → viewId must equal
 * - else non-empty text and/or contentDescription → each non-empty field must equal (case-sensitive)
 * - else Compose unlabeled: bounds center within [COMPOSE_BOUNDS_MATCH_PX] Euclidean of stored center
 */
fun identityAccepts(ref: NodeRef, node: ResolvableNode): Boolean {
    if (ref.className != node.className) return false

    if (ref.viewId.isNotEmpty()) {
        return ref.viewId == node.viewId
    }

    val hasText = ref.text.isNotEmpty()
    val hasCd = ref.contentDescription.isNotEmpty()
    if (hasText || hasCd) {
        if (hasText && ref.text != node.text) return false
        if (hasCd && ref.contentDescription != node.contentDescription) return false
        return true
    }

    val dx = (ref.boundsCenterX - node.boundsCenterX).toDouble()
    val dy = (ref.boundsCenterY - node.boundsCenterY).toDouble()
    return sqrt(dx * dx + dy * dy) <= COMPOSE_BOUNDS_MATCH_PX.toDouble()
}

// ---------------------------------------------------------------------------
// Pure DFS dump: id assignment n0..nN, hard cap, NodeRef map
// ---------------------------------------------------------------------------

data class FlatDumpNode(
    val id: String,
    /** Parent id, or null for root. */
    val pid: String?,
    val depth: Int,
    val path: IntArray,
    val className: String,
    val viewId: String,
    val text: String,
    val contentDescription: String,
    val packageName: String,
    val bounds: NodeBounds,
) {
    fun pathString(): String = path.joinToString("/")
}

data class DumpBuildResult(
    val nodes: List<FlatDumpNode>,
    val byId: Map<String, NodeRef>,
    val truncated: Boolean,
)

/**
 * DFS walk assigning sequential `n0…nN` ids. Stops after [NODE_HARD_CAP] nodes
 * (or [limit] if 1..hardCap). [limit] ≤ 0 means hard cap only.
 */
fun buildNodeDump(
    root: ResolvableNode,
    maxDepth: Int = 12,
    limit: Int = 0,
): DumpBuildResult {
    val cap = effectiveNodeLimit(limit)
    val nodes = ArrayList<FlatDumpNode>(minOf(cap, 64))
    val byId = LinkedHashMap<String, NodeRef>()
    var nextId = 0
    var truncated = false

    fun walk(node: ResolvableNode, depth: Int, path: IntArray, parentId: String?) {
        if (nodes.size >= cap) {
            truncated = true
            return
        }
        if (depth > maxDepth) return

        val id = "n$nextId"
        nextId++
        val bounds = node.bounds
        val flat = FlatDumpNode(
            id = id,
            pid = parentId,
            depth = depth,
            path = path,
            className = node.className,
            viewId = node.viewId,
            text = node.text,
            contentDescription = node.contentDescription,
            packageName = node.packageName,
            bounds = bounds,
        )
        nodes.add(flat)
        byId[id] = NodeRef(
            id = id,
            path = path,
            className = node.className,
            viewId = node.viewId,
            text = node.text,
            contentDescription = node.contentDescription,
            packageName = node.packageName,
            boundsCenterX = bounds.centerX,
            boundsCenterY = bounds.centerY,
            bounds = bounds,
        )

        if (depth >= maxDepth) return
        for (i in 0 until node.childCount) {
            if (nodes.size >= cap) {
                truncated = true
                return
            }
            val child = node.getChild(i) ?: continue
            val childPath = path + i
            walk(child, depth + 1, childPath, id)
            if (truncated) return
        }
    }

    walk(root, depth = 0, path = intArrayOf(), parentId = null)
    return DumpBuildResult(nodes = nodes, byId = byId, truncated = truncated)
}

/** Effective max nodes: always ≤ [NODE_HARD_CAP]; [limit] ≤ 0 → hard cap. */
fun effectiveNodeLimit(limit: Int): Int {
    if (limit <= 0) return NODE_HARD_CAP
    return minOf(limit, NODE_HARD_CAP)
}

// ---------------------------------------------------------------------------
// Service-facing node_click outcomes + HTTP envelope
// ---------------------------------------------------------------------------

/**
 * Result of [dev.rivet.app.device.RivetAccessibilityService.nodeClick].
 * Gesture fallback reuses PR2 [GestureAwaitOutcome] (including busy).
 */
sealed class NodeClickOutcome {
    /** ACTION_CLICK returned true (no gesture dispatch). */
    data class PerformClickOk(val durationMs: Long = 0L) : NodeClickOutcome()

    /** ACTION_CLICK false; center-tap gesture was attempted. */
    data class GestureFallback(val outcome: GestureAwaitOutcome) : NodeClickOutcome()

    data object StaleNode : NodeClickOutcome()
    data object A11yDisconnected : NodeClickOutcome()

    /** ACTION_CLICK false and no usable bounds for gesture fallback. */
    data object ClickFailed : NodeClickOutcome()
}

/**
 * Map [NodeClickOutcome] to the PR2-style action envelope with `type: node_action`.
 */
fun mapNodeActionClickToHttp(
    nodeId: String,
    outcome: NodeClickOutcome,
    executedAt: Long = System.currentTimeMillis(),
): HttpResponse {
    when (outcome) {
        is NodeClickOutcome.StaleNode -> {
            return errorResponse(
                code = 400,
                error = "stale_node",
                message = "nodeId expired or failed re-resolve; re-dump /ui and retry",
            )
        }
        is NodeClickOutcome.A11yDisconnected -> {
            return errorResponse(
                code = 503,
                error = "a11y_disconnected",
                message = "accessibility service not connected — enable it in Settings",
            )
        }
        is NodeClickOutcome.ClickFailed -> {
            val body = JSONObject()
                .put("ok", false)
                .put("type", "node_action")
                .put("nodeId", nodeId)
                .put("action", "click")
                .put("completed", false)
                .put("durationMs", 0L)
                .put("executed_at", executedAt)
                .put("error", "action_failed")
            return jsonResponse(200, body)
        }
        is NodeClickOutcome.PerformClickOk -> {
            val body = JSONObject()
                .put("ok", true)
                .put("type", "node_action")
                .put("nodeId", nodeId)
                .put("action", "click")
                .put("completed", true)
                .put("durationMs", outcome.durationMs)
                .put("executed_at", executedAt)
            return jsonResponse(200, body)
        }
        is NodeClickOutcome.GestureFallback -> {
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
                        .put("type", "node_action")
                        .put("nodeId", nodeId)
                        .put("action", "click")
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

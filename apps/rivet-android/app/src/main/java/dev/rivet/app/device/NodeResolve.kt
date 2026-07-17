package dev.rivet.app.device

import org.json.JSONArray
import org.json.JSONObject
import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException
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
/** Max length of `textRegex` query param before compile (ReDoS guard). */
const val TEXT_REGEX_MAX_LEN = 64
/** Euclidean px tolerance for Compose unlabeled identity (class already matched). */
const val COMPOSE_BOUNDS_MATCH_PX = 48

/**
 * Lightweight tree node for pure resolve / dump tests.
 * Implementations must not require the Android framework.
 * Flag defaults keep PR3a mock trees compiling; PR3b filters read the flags.
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
    val clickable: Boolean get() = false
    val editable: Boolean get() = false
    val focusable: Boolean get() = false
    val focused: Boolean get() = false
    val scrollable: Boolean get() = false
    val enabled: Boolean get() = true
    val checked: Boolean get() = false
    val selected: Boolean get() = false
    val visible: Boolean get() = true
    val hint: String get() = ""
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
// Formats / filters are projections over the full walked list (PR3b).
// ---------------------------------------------------------------------------

enum class UiDumpFormat {
    FLAT,
    TREE,
    COMPACT,
    ;

    companion object {
        fun parse(s: String?): UiDumpFormat? = when (s?.lowercase()) {
            null, "", "flat" -> FLAT
            "tree" -> TREE
            "compact" -> COMPACT
            else -> null
        }
    }
}

/**
 * Emission filters for `/ui`. Applied after the full hard-capped walk so [NodeIndex]
 * still indexes every walked node (resolve works for ids not present in the response).
 */
data class UiDumpFilters(
    val clickableOnly: Boolean = false,
    val editableOnly: Boolean = false,
    /** Case-insensitive substring on text or contentDescription. */
    val textContains: String? = null,
    /** Exact match on text or contentDescription (case-sensitive). */
    val textExact: String? = null,
    /** Compiled regex applied with [Matcher.find] on text or contentDescription. */
    val textRegex: Pattern? = null,
    /** Substring on viewId (case-insensitive). */
    val viewIdContains: String? = null,
    /** Exact package name match. */
    val packageEquals: String? = null,
    /** Substring on className (case-insensitive). */
    val classContains: String? = null,
    /** When true (default), drop nodes with visible=false from emission. */
    val visibleOnly: Boolean = true,
)

data class UiDumpQuery(
    val format: UiDumpFormat = UiDumpFormat.FLAT,
    val maxDepth: Int = 12,
    val includeBounds: Boolean = true,
    /** Max nodes emitted; ≤0 means no emit limit beyond the hard-capped walk. */
    val limit: Int = 0,
    /** Slim field allowlist; null/empty means all fields. Always keeps `id`. */
    val fields: Set<String>? = null,
    val filters: UiDumpFilters = UiDumpFilters(),
)

sealed class ParseUiQueryResult {
    data class Ok(val query: UiDumpQuery) : ParseUiQueryResult()
    data class BadRequest(val message: String) : ParseUiQueryResult()
}

/**
 * Parse GET /ui query params (PR3a + PR3b). Unknown format / bad regex → [BadRequest].
 */
fun parseUiQuery(query: Map<String, String>): ParseUiQueryResult {
    val format = UiDumpFormat.parse(query["format"])
        ?: return ParseUiQueryResult.BadRequest(
            "format must be flat|tree|compact (got '${query["format"]}')",
        )
    val maxDepth = query["maxDepth"]?.toIntOrNull()?.coerceIn(0, 64) ?: 12
    val includeBounds = when (query["bounds"]?.lowercase()) {
        null, "", "1", "true", "yes" -> true
        "0", "false", "no" -> false
        else -> true
    }
    val limit = query["limit"]?.toIntOrNull() ?: 0

    val fieldsRaw = query["fields"]?.trim().orEmpty()
    val fields: Set<String>? = if (fieldsRaw.isEmpty()) {
        null
    } else {
        fieldsRaw.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    }

    val clickableOnly = isTruthyFlag(query["clickable"])
    val editableOnly = isTruthyFlag(query["editable"])
    val textContains = query["text"]?.takeIf { it.isNotEmpty() }
    val textExact = query["textExact"]?.takeIf { it.isNotEmpty() }
    val viewIdContains = query["viewId"]?.takeIf { it.isNotEmpty() }
    val packageEquals = query["package"]?.takeIf { it.isNotEmpty() }
    val classContains = query["class"]?.takeIf { it.isNotEmpty() }
    val visibleOnly = when (query["visible"]?.lowercase()) {
        null, "", "1", "true", "yes" -> true
        "0", "false", "no" -> false
        else -> true
    }

    val textRegexPattern: Pattern? = query["textRegex"]?.let { raw ->
        if (raw.isEmpty()) return@let null
        if (raw.length > TEXT_REGEX_MAX_LEN) {
            return ParseUiQueryResult.BadRequest(
                "textRegex max length is $TEXT_REGEX_MAX_LEN (got ${raw.length})",
            )
        }
        try {
            Pattern.compile(raw)
        } catch (_: PatternSyntaxException) {
            return ParseUiQueryResult.BadRequest("textRegex is not a valid pattern")
        }
    }

    return ParseUiQueryResult.Ok(
        UiDumpQuery(
            format = format,
            maxDepth = maxDepth,
            includeBounds = includeBounds,
            limit = limit,
            fields = fields,
            filters = UiDumpFilters(
                clickableOnly = clickableOnly,
                editableOnly = editableOnly,
                textContains = textContains,
                textExact = textExact,
                textRegex = textRegexPattern,
                viewIdContains = viewIdContains,
                packageEquals = packageEquals,
                classContains = classContains,
                visibleOnly = visibleOnly,
            ),
        ),
    )
}

private fun isTruthyFlag(raw: String?): Boolean = when (raw?.lowercase()) {
    "1", "true", "yes" -> true
    else -> false
}

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
    val clickable: Boolean = false,
    val editable: Boolean = false,
    val focusable: Boolean = false,
    val focused: Boolean = false,
    val scrollable: Boolean = false,
    val enabled: Boolean = true,
    val checked: Boolean = false,
    val selected: Boolean = false,
    val visible: Boolean = true,
    val hint: String = "",
) {
    fun pathString(): String = path.joinToString("/")
}

data class DumpBuildResult(
    val nodes: List<FlatDumpNode>,
    val byId: Map<String, NodeRef>,
    /** True when the underlying DFS hit [NODE_HARD_CAP]. */
    val truncated: Boolean,
)

/**
 * DFS walk assigning sequential `n0…nN` ids. Always hard-capped at [NODE_HARD_CAP]
 * regardless of emission [limit] (PR3b: limit/filters are projections only).
 *
 * [limit] is accepted for back-compat with PR3a call sites but **ignored for the walk** —
 * use [selectEmittedNodes] for emit capping.
 */
fun buildNodeDump(
    root: ResolvableNode,
    maxDepth: Int = 12,
    @Suppress("UNUSED_PARAMETER") limit: Int = 0,
): DumpBuildResult {
    val cap = NODE_HARD_CAP
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
        val pathCopy = path.copyOf()
        val flat = FlatDumpNode(
            id = id,
            pid = parentId,
            depth = depth,
            path = pathCopy,
            className = node.className,
            viewId = node.viewId,
            text = node.text,
            contentDescription = node.contentDescription,
            packageName = node.packageName,
            bounds = bounds,
            clickable = node.clickable,
            editable = node.editable,
            focusable = node.focusable,
            focused = node.focused,
            scrollable = node.scrollable,
            enabled = node.enabled,
            checked = node.checked,
            selected = node.selected,
            visible = node.visible,
            hint = node.hint,
        )
        nodes.add(flat)
        byId[id] = NodeRef(
            id = id,
            path = pathCopy,
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

/**
 * PR3a helper retained for tests/callers: clamps a numeric limit into 1..[NODE_HARD_CAP]
 * (≤0 → hard cap). The dump **walk** always uses [NODE_HARD_CAP] directly; emission uses
 * [effectiveEmitLimit] instead.
 */
fun effectiveNodeLimit(limit: Int): Int {
    if (limit <= 0) return NODE_HARD_CAP
    return minOf(limit, NODE_HARD_CAP)
}

/** Max nodes to emit after filters; ≤0 means unlimited (still ≤ walked size). */
fun effectiveEmitLimit(limit: Int): Int {
    if (limit <= 0) return Int.MAX_VALUE
    return limit
}

/** Compact / agent-interesting: clickable OR editable OR scrollable OR non-empty text/cd. */
fun isInterestingNode(n: FlatDumpNode): Boolean =
    n.clickable ||
        n.editable ||
        n.scrollable ||
        n.text.isNotEmpty() ||
        n.contentDescription.isNotEmpty()

/** Whether [n] passes emission [filters] (does not apply compact). */
fun matchesUiFilters(n: FlatDumpNode, filters: UiDumpFilters): Boolean {
    if (filters.visibleOnly && !n.visible) return false
    if (filters.clickableOnly && !n.clickable) return false
    if (filters.editableOnly && !n.editable) return false
    filters.textContains?.let { q ->
        val hit = n.text.contains(q, ignoreCase = true) ||
            n.contentDescription.contains(q, ignoreCase = true)
        if (!hit) return false
    }
    filters.textExact?.let { q ->
        if (n.text != q && n.contentDescription != q) return false
    }
    filters.textRegex?.let { pat ->
        val hit = pat.matcher(n.text).find() || pat.matcher(n.contentDescription).find()
        if (!hit) return false
    }
    filters.viewIdContains?.let { q ->
        if (!n.viewId.contains(q, ignoreCase = true)) return false
    }
    filters.packageEquals?.let { q ->
        if (n.packageName != q) return false
    }
    filters.classContains?.let { q ->
        if (!n.className.contains(q, ignoreCase = true)) return false
    }
    return true
}

/**
 * Select nodes for emission: optional compact interest filter, then [filters], then emit [limit].
 * Does not mutate the full walked list / index.
 *
 * @return emitted nodes in DFS order, and whether the emit limit cut off more matches.
 */
fun selectEmittedNodes(
    nodes: List<FlatDumpNode>,
    format: UiDumpFormat,
    filters: UiDumpFilters = UiDumpFilters(),
    limit: Int = 0,
): Pair<List<FlatDumpNode>, Boolean> {
    val emitCap = effectiveEmitLimit(limit)
    val out = ArrayList<FlatDumpNode>(minOf(nodes.size, 64))
    var emitTruncated = false
    for (n in nodes) {
        if (format == UiDumpFormat.COMPACT && !isInterestingNode(n)) continue
        if (!matchesUiFilters(n, filters)) continue
        if (out.size >= emitCap) {
            emitTruncated = true
            break
        }
        out.add(n)
    }
    return out to emitTruncated
}

/** Known `/ui` node field names (plus always-kept `id`). */
val UI_NODE_ALL_FIELDS: Set<String> = setOf(
    "id", "pid", "depth", "path", "class", "text", "contentDescription", "hint",
    "viewId", "package", "clickable", "editable", "focusable", "focused", "scrollable",
    "enabled", "checked", "selected", "visible", "bounds",
)

/**
 * Project one node to JSON. [fields] null → all fields; always includes `id`.
 * [includeBounds] gates bounds even when listed in fields.
 */
fun flatDumpNodeToJson(
    n: FlatDumpNode,
    includeBounds: Boolean = true,
    fields: Set<String>? = null,
): JSONObject {
    val allow = fields?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet()
    fun keep(name: String): Boolean = name == "id" || allow == null || name in allow

    val obj = JSONObject()
    if (keep("id")) obj.put("id", n.id)
    if (keep("pid")) {
        if (n.pid != null) obj.put("pid", n.pid) else obj.put("pid", JSONObject.NULL)
    }
    if (keep("depth")) obj.put("depth", n.depth)
    if (keep("path")) obj.put("path", n.pathString())
    if (keep("class")) obj.put("class", n.className)
    if (keep("text")) obj.put("text", n.text)
    if (keep("contentDescription")) obj.put("contentDescription", n.contentDescription)
    if (keep("hint")) obj.put("hint", n.hint)
    if (keep("viewId")) obj.put("viewId", n.viewId)
    if (keep("package")) obj.put("package", n.packageName)
    if (keep("clickable")) obj.put("clickable", n.clickable)
    if (keep("editable")) obj.put("editable", n.editable)
    if (keep("focusable")) obj.put("focusable", n.focusable)
    if (keep("focused")) obj.put("focused", n.focused)
    if (keep("scrollable")) obj.put("scrollable", n.scrollable)
    if (keep("enabled")) obj.put("enabled", n.enabled)
    if (keep("checked")) obj.put("checked", n.checked)
    if (keep("selected")) obj.put("selected", n.selected)
    if (keep("visible")) obj.put("visible", n.visible)
    if (keep("bounds") && includeBounds) {
        val b = JSONObject()
        b.put("left", n.bounds.left)
        b.put("top", n.bounds.top)
        b.put("right", n.bounds.right)
        b.put("bottom", n.bounds.bottom)
        b.put("width", n.bounds.width)
        b.put("height", n.bounds.height)
        obj.put("bounds", b)
    }
    return obj
}

private fun buildTreeJsonArray(
    emitted: List<FlatDumpNode>,
    allById: Map<String, FlatDumpNode>,
    includeBounds: Boolean,
    fields: Set<String>?,
): JSONArray {
    data class TB(val node: FlatDumpNode, val children: MutableList<TB> = mutableListOf())

    val emittedIds = emitted.map { it.id }.toSet()
    val builders = LinkedHashMap<String, TB>()
    for (n in emitted) builders[n.id] = TB(n)

    fun nearestEmittedAncestor(startPid: String?): String? {
        var cur = startPid
        while (cur != null) {
            if (cur in emittedIds) return cur
            cur = allById[cur]?.pid
        }
        return null
    }

    val roots = ArrayList<TB>()
    for (n in emitted) {
        val parentId = nearestEmittedAncestor(n.pid)
        val b = builders[n.id]!!
        if (parentId == null) roots.add(b) else builders[parentId]!!.children.add(b)
    }

    fun toJson(tb: TB): JSONObject {
        val obj = flatDumpNodeToJson(tb.node, includeBounds = includeBounds, fields = fields)
        val kids = JSONArray()
        for (c in tb.children) kids.put(toJson(c))
        // Always expose children for tree format (even if fields allowlist omits it)
        obj.put("children", kids)
        return obj
    }

    val arr = JSONArray()
    for (r in roots) arr.put(toJson(r))
    return arr
}

/**
 * Project a full walk into the `/ui` response body.
 * [NodeIndex] should be built from [DumpBuildResult.byId] (full walk), not from emitted nodes.
 */
fun projectUiDump(
    dump: DumpBuildResult,
    format: UiDumpFormat = UiDumpFormat.FLAT,
    filters: UiDumpFilters = UiDumpFilters(),
    limit: Int = 0,
    includeBounds: Boolean = true,
    fields: Set<String>? = null,
    packageName: String = "unknown",
    timestamp: Long = System.currentTimeMillis(),
    dumpId: Long = timestamp,
): JSONObject {
    val (emitted, emitTruncated) = selectEmittedNodes(dump.nodes, format, filters, limit)
    val allById = dump.nodes.associateBy { it.id }

    val json = JSONObject()
    json.put("package", packageName)
    json.put("timestamp", timestamp)
    json.put("dumpId", dumpId)
    json.put("format", format.name.lowercase())
    json.put("truncated", dump.truncated || emitTruncated)

    when (format) {
        UiDumpFormat.TREE -> {
            json.put(
                "nodes",
                buildTreeJsonArray(emitted, allById, includeBounds, fields),
            )
        }
        UiDumpFormat.FLAT, UiDumpFormat.COMPACT -> {
            val arr = JSONArray()
            for (n in emitted) {
                arr.put(flatDumpNodeToJson(n, includeBounds = includeBounds, fields = fields))
            }
            json.put("nodes", arr)
        }
    }
    return json
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

package dev.rivet.app.device

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * The "eyes + hands" of Rivet on the phone. Once enabled in Settings -> Accessibility,
 * it can walk the live UI tree, dispatch gestures, perform global nav, and type text.
 * It also hosts the loopback [ControlServer] for the lifetime of the binding, so device
 * access lights up exactly when the service is enabled and goes dark when it is disabled.
 */
class RivetAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile private var instance: RivetAccessibilityService? = null
        fun getInstance(): RivetAccessibilityService? = instance
        fun isRunning(): Boolean = instance != null

        // Reactive mirror of the binding state for in-process UI (drawer status strip) —
        // flips the instant the service binds/unbinds, no loopback polling round-trip.
        private val _connected = MutableStateFlow(false)
        val connected: StateFlow<Boolean> = _connected.asStateFlow()
    }

    /**
     * Event-cache root only — not authoritative for nodeId resolve.
     * Dumps prefer [rootInActiveWindow] first and fall back here if fresh root is null.
     */
    private var lastRoot: AccessibilityNodeInfo? = null
    private var lastPackage: String? = null
    private var server: ControlServer? = null

    /**
     * Per-dump node index for Resolve(nodeId). Replaced atomically on each successful dump.
     * Concurrent resolve holds a local snapshot of this reference at start.
     */
    @Volatile
    private var nodeIndex: NodeIndex? = null

    /** Single-flight FIFO queue for waited gestures (depth [GESTURE_MAX_QUEUE_DEPTH]). */
    private val gestureQueue = GestureFlightQueue()

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(DeviceControl.TAG, "Accessibility CONNECTED — Rivet can now see and drive the UI")
        // Never log the control secret in a release build (any adb/logcat reader would get it).
        if (dev.rivet.app.BuildConfig.DEBUG) {
            Log.i(DeviceControl.TAG, "Control token (X-Rivet-Token): ${DeviceControl.getControlToken(this)}")
        }
        DeviceControl.exportControlInfo(this)
        server = ControlServer(applicationContext).also { it.start() }
        _connected.value = true
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        _connected.value = false
        server?.stop(); server = null
        nodeIndex = null
        Log.w(DeviceControl.TAG, "Accessibility UNBOUND — device access off")
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        try {
            val root = rootInActiveWindow
            if (root != null) { lastRoot = root; lastPackage = root.packageName?.toString() }
        } catch (t: Throwable) {
            Log.e(DeviceControl.TAG, "root update failed", t)
        }
    }

    override fun onInterrupt() {}

    // ===== Public API used by ControlServer =====

    fun getCurrentPackage(): String? = lastPackage

    /** Prefer fresh active-window root; [lastRoot] is event cache only. */
    private fun preferredRoot(): AccessibilityNodeInfo? =
        try {
            rootInActiveWindow ?: lastRoot
        } catch (_: Throwable) {
            lastRoot
        }

    /**
     * UI dump with per-dump `id` / `pid` / `depth` / `path`, hard-capped walk at [NODE_HARD_CAP].
     * Builds and stores a full [NodeIndex] (all walked nodes) for [resolve] / [nodeClick].
     * Formats / filters / fields / emit [limit] are projections only — ids stay stable.
     *
     * Root policy: prefer fresh [rootInActiveWindow]; fall back to [lastRoot] only if null.
     */
    fun dumpUiTree(
        format: UiDumpFormat = UiDumpFormat.FLAT,
        includeBounds: Boolean = true,
        maxDepth: Int = 12,
        limit: Int = 0,
        filters: UiDumpFilters = UiDumpFilters(),
        fields: Set<String>? = null,
    ): JSONObject {
        val root = preferredRoot()
        val packageName = lastPackage ?: root?.packageName?.toString() ?: "unknown"
        val timestamp = System.currentTimeMillis()
        val byId = LinkedHashMap<String, NodeRef>()
        val walked = ArrayList<FlatDumpNode>(64)
        var walkTruncated = false
        if (root != null) {
            val state = DumpCollectState(
                walked = walked,
                byId = byId,
                maxDepth = maxDepth,
                cap = NODE_HARD_CAP,
            )
            collectNodes(
                node = root,
                depth = 0,
                path = intArrayOf(),
                parentId = null,
                state = state,
            )
            walkTruncated = state.truncated
        }

        val dump = DumpBuildResult(nodes = walked, byId = byId, truncated = walkTruncated)
        val index = NodeIndex(
            dumpId = timestamp,
            createdElapsedMs = SystemClock.elapsedRealtime(),
            ttlMs = NODE_INDEX_TTL_MS,
            byId = byId,
        )
        nodeIndex = index

        return projectUiDump(
            dump = dump,
            format = format,
            filters = filters,
            limit = limit,
            includeBounds = includeBounds,
            fields = fields,
            packageName = packageName,
            timestamp = timestamp,
            dumpId = index.dumpId,
        )
    }

    private class DumpCollectState(
        val walked: MutableList<FlatDumpNode>,
        val byId: MutableMap<String, NodeRef>,
        val maxDepth: Int,
        val cap: Int,
        var nextId: Int = 0,
        var truncated: Boolean = false,
    )

    /**
     * DFS collect with sequential ids into pure [FlatDumpNode] records + [NodeRef] index.
     * Recycles children after visiting; does not recycle [node] (caller owns root).
     * Always walks up to [NODE_HARD_CAP] — emission filters applied in [projectUiDump].
     */
    private fun collectNodes(
        node: AccessibilityNodeInfo,
        depth: Int,
        path: IntArray,
        parentId: String?,
        state: DumpCollectState,
    ) {
        if (state.walked.size >= state.cap) {
            state.truncated = true
            return
        }
        if (depth > state.maxDepth) return

        val id = "n${state.nextId}"
        state.nextId++
        val className = try { node.className?.toString() ?: "" } catch (_: Throwable) { "" }
        val viewId = try { node.viewIdResourceName ?: "" } catch (_: Throwable) { "" }
        val text = try { node.text?.toString() ?: "" } catch (_: Throwable) { "" }
        val contentDescription = try { node.contentDescription?.toString() ?: "" } catch (_: Throwable) { "" }
        val packageName = try { node.packageName?.toString() ?: "" } catch (_: Throwable) { "" }
        val hint = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                node.hintText?.toString() ?: ""
            } else {
                ""
            }
        } catch (_: Throwable) {
            ""
        }
        val r = Rect()
        try { node.getBoundsInScreen(r) } catch (_: Throwable) { }
        val bounds = NodeBounds(r.left, r.top, r.right, r.bottom)
        // Copy path so later mutations of the walk array cannot alias into the index.
        val pathCopy = path.copyOf()
        val flat = FlatDumpNode(
            id = id,
            pid = parentId,
            depth = depth,
            path = pathCopy,
            className = className,
            viewId = viewId,
            text = text,
            contentDescription = contentDescription,
            packageName = packageName,
            bounds = bounds,
            clickable = try { node.isClickable } catch (_: Throwable) { false },
            editable = try { node.isEditable } catch (_: Throwable) { false },
            focusable = try { node.isFocusable } catch (_: Throwable) { false },
            focused = try { node.isFocused } catch (_: Throwable) { false },
            scrollable = try { node.isScrollable } catch (_: Throwable) { false },
            enabled = try { node.isEnabled } catch (_: Throwable) { false },
            checked = try { node.isChecked } catch (_: Throwable) { false },
            selected = try { node.isSelected } catch (_: Throwable) { false },
            visible = try { node.isVisibleToUser } catch (_: Throwable) { false },
            hint = hint,
        )
        state.walked.add(flat)
        state.byId[id] = NodeRef(
            id = id,
            path = pathCopy,
            className = className,
            viewId = viewId,
            text = text,
            contentDescription = contentDescription,
            packageName = packageName,
            boundsCenterX = bounds.centerX,
            boundsCenterY = bounds.centerY,
            bounds = bounds,
        )

        if (depth >= state.maxDepth) return
        val childCount = try { node.childCount } catch (_: Throwable) { 0 }
        for (i in 0 until childCount) {
            if (state.walked.size >= state.cap) {
                state.truncated = true
                return
            }
            val child = try { node.getChild(i) } catch (_: Throwable) { null } ?: continue
            try {
                collectNodes(
                    node = child,
                    depth = depth + 1,
                    path = path + i,
                    parentId = id,
                    state = state,
                )
            } finally {
                safeRecycle(child)
            }
            if (state.truncated) return
        }
    }

    /**
     * Resolve [nodeId] against the current [nodeIndex] on a **fresh** [rootInActiveWindow]
     * (no lastRoot fallback).
     *
     * [ServiceResolveResult.Found.owned] is true when the returned node is a path child
     * the caller must recycle; false when it is the window root (must not recycle).
     */
    fun resolve(nodeId: String): ServiceResolveResult {
        val index = nodeIndex
        val now = SystemClock.elapsedRealtime()
        if (index == null || now - index.createdElapsedMs > index.ttlMs) {
            return ServiceResolveResult.StaleNode
        }
        val ref = index.byId[nodeId] ?: return ServiceResolveResult.StaleNode

        val root = try {
            rootInActiveWindow
        } catch (t: Throwable) {
            Log.e(DeviceControl.TAG, "rootInActiveWindow failed", t)
            null
        } ?: return ServiceResolveResult.A11yDisconnected

        // Walk path; recycle only owned intermediates (never the window root).
        var current: AccessibilityNodeInfo = root
        var owned = false
        try {
            for (childIndex in ref.path) {
                val child = try {
                    current.getChild(childIndex)
                } catch (_: Throwable) {
                    null
                }
                if (child == null) {
                    if (owned) safeRecycle(current)
                    return ServiceResolveResult.StaleNode
                }
                if (owned) safeRecycle(current)
                current = child
                owned = true
            }

            val live = AccessibilityResolvableNode(current)
            if (!identityAccepts(ref, live)) {
                if (owned) safeRecycle(current)
                return ServiceResolveResult.StaleNode
            }
            return ServiceResolveResult.Found(node = current, ref = ref, owned = owned)
        } catch (t: Throwable) {
            if (owned) safeRecycle(current)
            Log.e(DeviceControl.TAG, "resolve walk failed", t)
            return ServiceResolveResult.StaleNode
        }
    }

    /**
     * Resolve [nodeId] and click: prefer [AccessibilityNodeInfo.ACTION_CLICK]; if that returns
     * false and the node has non-empty bounds, fall back to a waited center-point tap via
     * [dispatchGestureAwait]. Recycles owned resolved nodes when done.
     */
    fun nodeClick(
        nodeId: String,
        timeoutMs: Long = GESTURE_DEFAULT_TIMEOUT_MS,
    ): NodeClickOutcome {
        return when (val o = nodeAction(nodeId, "click", text = null, timeoutMs = timeoutMs)) {
            is NodeActionOutcome.PerformOk -> NodeClickOutcome.PerformClickOk(o.durationMs)
            is NodeActionOutcome.GestureFallback -> NodeClickOutcome.GestureFallback(o.outcome)
            is NodeActionOutcome.StaleNode -> NodeClickOutcome.StaleNode
            is NodeActionOutcome.A11yDisconnected -> NodeClickOutcome.A11yDisconnected
            is NodeActionOutcome.ActionFailed -> NodeClickOutcome.ClickFailed
        }
    }

    /**
     * Resolve [nodeId] and perform a rich node action via [AccessibilityNodeInfo.performAction].
     * - `click` / `long_click`: on performAction false + usable bounds, gesture fallback
     *   (center tap / center long-press stroke).
     * - Other actions: performAction only (no gesture lock).
     * Always recycles owned resolved nodes; releases before any gesture wait.
     */
    fun nodeAction(
        nodeId: String,
        action: String,
        text: String? = null,
        timeoutMs: Long = GESTURE_DEFAULT_TIMEOUT_MS,
    ): NodeActionOutcome {
        val actionId = mapNodeActionNameToActionId(action)
            ?: return NodeActionOutcome.ActionFailed
        when (val resolved = resolve(nodeId)) {
            is ServiceResolveResult.StaleNode -> return NodeActionOutcome.StaleNode
            is ServiceResolveResult.A11yDisconnected -> return NodeActionOutcome.A11yDisconnected
            is ServiceResolveResult.Found -> {
                val node = resolved.node
                var stillOwned = resolved.owned
                try {
                    val start = System.currentTimeMillis()
                    val ok = try {
                        when (action.lowercase()) {
                            "set_text" -> {
                                val args = Bundle()
                                args.putCharSequence(
                                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                                    text ?: "",
                                )
                                node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                            }
                            else -> node.performAction(actionId)
                        }
                    } catch (t: Throwable) {
                        Log.e(DeviceControl.TAG, "performAction($action) failed: ${t.message}")
                        false
                    }
                    if (ok) {
                        return NodeActionOutcome.PerformOk(
                            durationMs = System.currentTimeMillis() - start,
                        )
                    }
                    // Gesture fallback only for click / long_click.
                    val kind = action.lowercase()
                    if (kind != "click" && kind != "long_click") {
                        return NodeActionOutcome.ActionFailed
                    }
                    val r = Rect()
                    try {
                        node.getBoundsInScreen(r)
                    } catch (_: Throwable) {
                    }
                    if (r.width() <= 0 || r.height() <= 0) {
                        return NodeActionOutcome.ActionFailed
                    }
                    val cx = r.centerX()
                    val cy = r.centerY()
                    if (stillOwned) {
                        safeRecycle(node)
                        stillOwned = false
                    }
                    val gestureOutcome = if (kind == "long_click") {
                        longPress(cx, cy, wait = true, timeoutMs = timeoutMs)
                    } else {
                        tap(cx, cy, wait = true, timeoutMs = timeoutMs)
                    }
                    return NodeActionOutcome.GestureFallback(gestureOutcome)
                } finally {
                    if (stillOwned) safeRecycle(node)
                }
            }
        }
    }

    /**
     * Long-press at screen coordinates (stroke ≥ [LONG_PRESS_MIN_DURATION_MS]).
     * Uses [dispatchGestureAwait] when [wait] is true.
     */
    fun longPress(
        x: Int,
        y: Int,
        durationMs: Long = LONG_PRESS_MIN_DURATION_MS,
        wait: Boolean = true,
        timeoutMs: Long = GESTURE_DEFAULT_TIMEOUT_MS,
    ): GestureAwaitOutcome {
        val hold = longPressDurationMs(durationMs)
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, hold))
            .build()
        return if (wait) {
            dispatchGestureAwait(gesture, timeoutMs)
        } else {
            fireAndForgetGesture(gesture)
        }
    }

    /**
     * Double-tap at screen coordinates: two short strokes with [DOUBLE_TAP_GAP_MS] offset.
     */
    fun doubleTap(
        x: Int,
        y: Int,
        wait: Boolean = true,
        timeoutMs: Long = GESTURE_DEFAULT_TIMEOUT_MS,
    ): GestureAwaitOutcome {
        val path1 = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val path2 = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path1, 0, DOUBLE_TAP_STROKE_MS))
            .addStroke(
                GestureDescription.StrokeDescription(path2, DOUBLE_TAP_GAP_MS, DOUBLE_TAP_STROKE_MS),
            )
            .build()
        return if (wait) {
            dispatchGestureAwait(gesture, timeoutMs)
        } else {
            fireAndForgetGesture(gesture)
        }
    }

    /**
     * Drag (single stroke) from (x1,y1) to (x2,y2).
     */
    fun drag(
        x1: Int,
        y1: Int,
        x2: Int,
        y2: Int,
        durationMs: Long = DRAG_DEFAULT_DURATION_MS,
        wait: Boolean = true,
        timeoutMs: Long = GESTURE_DEFAULT_TIMEOUT_MS,
    ): GestureAwaitOutcome {
        val dur = durationMs.coerceAtLeast(1L)
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, dur))
            .build()
        return if (wait) {
            dispatchGestureAwait(gesture, timeoutMs)
        } else {
            fireAndForgetGesture(gesture)
        }
    }

    /**
     * Scroll in [direction]. When [nodeId] is set: resolve + prefer directional
     * ACTION_SCROLL_* / FORWARD|BACKWARD; else coordinate swipe (node bounds or screen center).
     * performAction path does not take the gesture lock; swipe fallback does.
     */
    fun scroll(
        direction: ScrollDirection,
        nodeId: String? = null,
        durationMs: Long = SCROLL_SWIPE_DEFAULT_DURATION_MS,
        wait: Boolean = true,
        timeoutMs: Long = GESTURE_DEFAULT_TIMEOUT_MS,
    ): NodeActionOutcome {
        val id = nodeId?.trim()?.takeIf { it.isNotEmpty() }
        if (id != null) {
            when (val resolved = resolve(id)) {
                is ServiceResolveResult.StaleNode -> return NodeActionOutcome.StaleNode
                is ServiceResolveResult.A11yDisconnected -> return NodeActionOutcome.A11yDisconnected
                is ServiceResolveResult.Found -> {
                    val node = resolved.node
                    var stillOwned = resolved.owned
                    try {
                        val start = System.currentTimeMillis()
                        if (tryScrollPerformAction(node, direction)) {
                            return NodeActionOutcome.PerformOk(
                                durationMs = System.currentTimeMillis() - start,
                            )
                        }
                        val r = Rect()
                        try {
                            node.getBoundsInScreen(r)
                        } catch (_: Throwable) {
                        }
                        if (r.width() <= 0 || r.height() <= 0) {
                            return NodeActionOutcome.ActionFailed
                        }
                        val span = scrollSpanFromBounds(r.width(), r.height())
                        val seg = scrollDirectionToSwipe(
                            direction,
                            r.centerX(),
                            r.centerY(),
                            span,
                        )
                        if (stillOwned) {
                            safeRecycle(node)
                            stillOwned = false
                        }
                        return NodeActionOutcome.GestureFallback(
                            swipe(
                                x1 = seg.x1,
                                y1 = seg.y1,
                                x2 = seg.x2,
                                y2 = seg.y2,
                                durationMs = durationMs.coerceAtLeast(1L),
                                wait = wait,
                                timeoutMs = timeoutMs,
                            ),
                        )
                    } finally {
                        if (stillOwned) safeRecycle(node)
                    }
                }
            }
        }

        // Coordinate-only: swipe near screen center (gesture path).
        val dm = try {
            resources.displayMetrics
        } catch (_: Throwable) {
            null
        }
        val cx = (dm?.widthPixels ?: 1080) / 2
        val cy = (dm?.heightPixels ?: 2400) / 2
        val span = scrollSpanFromBounds(dm?.widthPixels ?: 1080, dm?.heightPixels ?: 2400)
        val seg = scrollDirectionToSwipe(direction, cx, cy, span)
        return NodeActionOutcome.GestureFallback(
            swipe(
                x1 = seg.x1,
                y1 = seg.y1,
                x2 = seg.x2,
                y2 = seg.y2,
                durationMs = durationMs.coerceAtLeast(1L),
                wait = wait,
                timeoutMs = timeoutMs,
            ),
        )
    }

    /**
     * Prefer API 23+ directional scroll actions; fall back to FORWARD/BACKWARD.
     */
    private fun tryScrollPerformAction(
        node: AccessibilityNodeInfo,
        direction: ScrollDirection,
    ): Boolean {
        val directionalId = when (direction) {
            ScrollDirection.UP -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
            ScrollDirection.DOWN -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
            ScrollDirection.LEFT -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
            ScrollDirection.RIGHT -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
        }
        try {
            if (node.performAction(directionalId)) return true
        } catch (t: Throwable) {
            Log.e(DeviceControl.TAG, "directional scroll failed: ${t.message}")
        }
        val fb = scrollDirectionToForwardBackward(direction)
        return try {
            node.performAction(fb)
        } catch (t: Throwable) {
            Log.e(DeviceControl.TAG, "forward/backward scroll failed: ${t.message}")
            false
        }
    }

    private fun safeRecycle(node: AccessibilityNodeInfo) {
        try {
            node.recycle()
        } catch (_: Throwable) {
        }
    }

    /**
     * Tap at screen coordinates.
     * @param wait true (default) → [dispatchGestureAwait] with completion; false → fire-and-forget
     *   (no gesture lock; [GestureResult.accepted] only is meaningful).
     */
    fun tap(
        x: Int,
        y: Int,
        durationMs: Long = 60,
        wait: Boolean = true,
        timeoutMs: Long = GESTURE_DEFAULT_TIMEOUT_MS,
    ): GestureAwaitOutcome {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build()
        return if (wait) {
            dispatchGestureAwait(gesture, timeoutMs)
        } else {
            fireAndForgetGesture(gesture)
        }
    }

    /**
     * Swipe between screen coordinates.
     * @param wait true (default) → [dispatchGestureAwait]; false → fire-and-forget.
     */
    fun swipe(
        x1: Int,
        y1: Int,
        x2: Int,
        y2: Int,
        durationMs: Long = 250,
        wait: Boolean = true,
        timeoutMs: Long = GESTURE_DEFAULT_TIMEOUT_MS,
    ): GestureAwaitOutcome {
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build()
        return if (wait) {
            dispatchGestureAwait(gesture, timeoutMs)
        } else {
            fireAndForgetGesture(gesture)
        }
    }

    private fun fireAndForgetGesture(gesture: GestureDescription): GestureAwaitOutcome {
        val accepted = try {
            dispatchGesture(gesture, null, null)
        } catch (t: Throwable) {
            Log.e(DeviceControl.TAG, "dispatchGesture fire-and-forget failed: ${t.message}")
            false
        }
        return GestureAwaitOutcome.Done(
            GestureResult(
                accepted = accepted,
                completed = false,
                cancelled = false,
                timedOut = false,
                durationMs = 0L,
            ),
        )
    }

    /**
     * Dispatch a gesture and wait for [GestureResultCallback] completion/cancel or timeout.
     * Serializes through [gestureQueue] (single-flight, FIFO, depth [GESTURE_MAX_QUEUE_DEPTH]).
     * Queue wait time is deducted from [timeoutMs].
     *
     * Non-gesture actions must not call this (they do not take the lock).
     */
    fun dispatchGestureAwait(
        gesture: GestureDescription,
        timeoutMs: Long = GESTURE_DEFAULT_TIMEOUT_MS,
    ): GestureAwaitOutcome {
        val start = System.currentTimeMillis()
        val budget = timeoutMs.coerceIn(1L, GESTURE_MAX_TIMEOUT_MS)
        when (val enter = gestureQueue.tryEnter(budget)) {
            is GestureFlightQueue.EnterResult.Busy -> return GestureAwaitOutcome.Busy
            is GestureFlightQueue.EnterResult.TimedOut -> {
                return GestureAwaitOutcome.Done(
                    GestureResult(
                        accepted = false,
                        completed = false,
                        cancelled = false,
                        timedOut = true,
                        durationMs = System.currentTimeMillis() - start,
                    ),
                )
            }
            is GestureFlightQueue.EnterResult.Acquired -> {
                try {
                    val remaining = enter.remainingTimeoutMs
                    if (remaining <= 0L) {
                        return GestureAwaitOutcome.Done(
                            GestureResult(
                                accepted = false,
                                completed = false,
                                cancelled = false,
                                timedOut = true,
                                durationMs = System.currentTimeMillis() - start,
                            ),
                        )
                    }
                    return GestureAwaitOutcome.Done(
                        dispatchGestureWithCallback(gesture, remaining, start),
                    )
                } finally {
                    gestureQueue.leave()
                }
            }
        }
    }

    private fun dispatchGestureWithCallback(
        gesture: GestureDescription,
        remainingMs: Long,
        startMs: Long,
    ): GestureResult {
        val completedRef = AtomicReference<Boolean?>(null)
        val latch = CountDownLatch(1)
        val accepted = try {
            dispatchGesture(
                gesture,
                object : GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) {
                        completedRef.compareAndSet(null, true)
                        latch.countDown()
                    }

                    override fun onCancelled(gestureDescription: GestureDescription?) {
                        completedRef.compareAndSet(null, false)
                        latch.countDown()
                    }
                },
                null,
            )
        } catch (t: Throwable) {
            Log.e(DeviceControl.TAG, "dispatchGesture failed: ${t.message}")
            return GestureResult(
                accepted = false,
                completed = false,
                cancelled = false,
                timedOut = false,
                durationMs = System.currentTimeMillis() - startMs,
            )
        }

        if (!accepted) {
            return GestureResult(
                accepted = false,
                completed = false,
                cancelled = false,
                timedOut = false,
                durationMs = System.currentTimeMillis() - startMs,
            )
        }

        val finished = try {
            latch.await(remainingMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }

        val duration = System.currentTimeMillis() - startMs
        if (!finished) {
            return GestureResult(
                accepted = true,
                completed = false,
                cancelled = false,
                timedOut = true,
                durationMs = duration,
            )
        }
        return when (completedRef.get()) {
            true -> GestureResult(
                accepted = true,
                completed = true,
                cancelled = false,
                timedOut = false,
                durationMs = duration,
            )
            false -> GestureResult(
                accepted = true,
                completed = false,
                cancelled = true,
                timedOut = false,
                durationMs = duration,
            )
            null -> GestureResult(
                accepted = true,
                completed = false,
                cancelled = false,
                timedOut = true,
                durationMs = duration,
            )
        }
    }

    /**
     * Type into the focused (or first editable) field.
     * @param mode `replace` (default) overwrites; `append` concatenates onto current text.
     */
    fun typeText(text: String, mode: String = "replace"): Boolean {
        val root = preferredRoot() ?: return false
        var target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (target == null || !target.isFocused) target = findFirstEditable(root)
        if (target == null) return false
        val current = try {
            target.text?.toString() ?: ""
        } catch (_: Throwable) {
            ""
        }
        val payload = resolveTextPayload(mode, current, text)
        val args = Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, payload)
        return target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findFirstEditable(child)?.let { return it }
            child.recycle()
        }
        return null
    }

    fun clickNodeContainingText(text: String, packageFilter: String? = null): Boolean {
        val root = preferredRoot() ?: return false
        val target = findNodeContainingText(root, text, packageFilter)
        return target?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
    }

    private fun findNodeContainingText(node: AccessibilityNodeInfo, text: String, packageFilter: String?): AccessibilityNodeInfo? {
        val t = node.text?.toString()?.lowercase() ?: ""
        val cd = node.contentDescription?.toString()?.lowercase() ?: ""
        val want = text.lowercase()
        if ((t.contains(want) || cd.contains(want)) &&
            (packageFilter == null || node.packageName?.toString() == packageFilter)) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findNodeContainingText(child, text, packageFilter)?.let { return it }
            child.recycle()
        }
        return null
    }

    fun performGlobal(action: Int): Boolean = performGlobalAction(action)

    /**
     * Capture a scaled JPEG screenshot via [takeScreenshot] (API 30+).
     * Ordered bitmap path from Fidelity T1.1 — never logs image bytes.
     * Blocks the calling worker thread up to [timeoutMs] (default 5s, cap 15s).
     */
    fun takeScaledScreenshot(
        scale: Float,
        quality: Int,
        displayId: Int = Display.DEFAULT_DISPLAY,
        timeoutMs: Long = SCREENSHOT_DEFAULT_TIMEOUT_MS,
    ): ScreenshotOutcome {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return ScreenshotOutcome.Unsupported
        }
        val cappedTimeout = timeoutMs.coerceIn(1L, SCREENSHOT_MAX_TIMEOUT_MS)
        val resultRef = AtomicReference<ScreenshotOutcome?>(null)
        val latch = CountDownLatch(1)

        try {
            takeScreenshot(
                displayId,
                mainExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshot: ScreenshotResult) {
                        try {
                            resultRef.set(encodeScreenshot(screenshot, scale, quality))
                        } catch (t: Throwable) {
                            // Do not log screenshot bytes — message only.
                            Log.e(DeviceControl.TAG, "screenshot encode failed: ${t.message}")
                            resultRef.set(
                                ScreenshotOutcome.Error(
                                    "internal_error",
                                    "screenshot encode failed: ${t.message}",
                                ),
                            )
                        } finally {
                            latch.countDown()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        val (err, msg) = mapTakeScreenshotErrorCode(errorCode)
                        resultRef.set(ScreenshotOutcome.Error(err, msg))
                        latch.countDown()
                    }
                },
            )
        } catch (t: Throwable) {
            Log.e(DeviceControl.TAG, "takeScreenshot threw: ${t.message}")
            return ScreenshotOutcome.Error(
                "internal_error",
                "takeScreenshot failed: ${t.message}",
            )
        }

        val completed = try {
            latch.await(cappedTimeout, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }

        if (!completed) {
            return ScreenshotOutcome.Error(
                "timed_out",
                "screenshot timed out after ${cappedTimeout}ms",
            )
        }
        return resultRef.get()
            ?: ScreenshotOutcome.Error("internal_error", "screenshot produced no result")
    }

    /**
     * Hardware buffer → software copy → scale → JPEG.
     * Closes the HardwareBuffer in finally; recycles intermediate bitmaps.
     */
    private fun encodeScreenshot(
        screenshot: ScreenshotResult,
        scale: Float,
        quality: Int,
    ): ScreenshotOutcome {
        val buf = screenshot.hardwareBuffer
            ?: return ScreenshotOutcome.Error("internal_error", "null hardware buffer")
        var hw: Bitmap? = null
        var sw: Bitmap? = null
        var scaled: Bitmap? = null
        try {
            hw = Bitmap.wrapHardwareBuffer(buf, screenshot.colorSpace)
                ?: return ScreenshotOutcome.Error("internal_error", "wrapHardwareBuffer returned null")
            sw = hw.copy(Bitmap.Config.ARGB_8888, false)
                ?: return ScreenshotOutcome.Error("internal_error", "bitmap software copy failed")
            hw.recycle()
            hw = null

            val w = sw.width
            val h = sw.height
            if (w <= 0 || h <= 0) {
                return ScreenshotOutcome.Error("internal_error", "invalid bitmap size ${w}x${h}")
            }
            val maxEdge = maxOf(w, h).toFloat()
            val scaleEff = minOf(scale, SCREENSHOT_MAX_EDGE / maxEdge)
            val tw = maxOf(1, (w * scaleEff).toInt())
            val th = maxOf(1, (h * scaleEff).toInt())
            scaled = if (tw == w && th == h) {
                // Transfer ownership to scaled; avoid double-recycle in finally.
                val same = sw
                sw = null
                same
            } else {
                Bitmap.createScaledBitmap(sw, tw, th, true).also {
                    if (it !== sw) {
                        sw.recycle()
                    }
                    sw = null
                }
            }
            val baos = ByteArrayOutputStream()
            val ok = scaled!!.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), baos)
            if (!ok) {
                return ScreenshotOutcome.Error("internal_error", "JPEG compress failed")
            }
            val bytes = baos.toByteArray()
            val outW = scaled!!.width
            val outH = scaled!!.height
            scaled!!.recycle()
            scaled = null
            return ScreenshotOutcome.Success(
                bytes = bytes,
                width = outW,
                height = outH,
                scaleApplied = scaleEff,
            )
        } finally {
            try {
                scaled?.recycle()
            } catch (_: Throwable) {
            }
            try {
                sw?.recycle()
            } catch (_: Throwable) {
            }
            try {
                hw?.recycle()
            } catch (_: Throwable) {
            }
            try {
                buf.close()
            } catch (_: Throwable) {
            }
        }
    }
}

/** Service-layer resolve result; [Found.node] must be recycled by the caller only if [Found.owned]. */
sealed class ServiceResolveResult {
    data class Found(
        val node: AccessibilityNodeInfo,
        val ref: NodeRef,
        /** True when [node] is a getChild result (must recycle). False for the window root. */
        val owned: Boolean,
    ) : ServiceResolveResult()
    data object StaleNode : ServiceResolveResult()
    data object A11yDisconnected : ServiceResolveResult()
}

/**
 * [ResolvableNode] adapter over a live [AccessibilityNodeInfo] (read-only identity fields).
 * Does not own or recycle the node.
 */
private class AccessibilityResolvableNode(
    private val node: AccessibilityNodeInfo,
) : ResolvableNode {
    override val childCount: Int
        get() = try {
            node.childCount
        } catch (_: Throwable) {
            0
        }

    override fun getChild(i: Int): ResolvableNode? = null // path already walked; identity only

    override val className: String
        get() = try {
            node.className?.toString() ?: ""
        } catch (_: Throwable) {
            ""
        }
    override val viewId: String
        get() = try {
            node.viewIdResourceName ?: ""
        } catch (_: Throwable) {
            ""
        }
    override val text: String
        get() = try {
            node.text?.toString() ?: ""
        } catch (_: Throwable) {
            ""
        }
    override val contentDescription: String
        get() = try {
            node.contentDescription?.toString() ?: ""
        } catch (_: Throwable) {
            ""
        }
    override val packageName: String
        get() = try {
            node.packageName?.toString() ?: ""
        } catch (_: Throwable) {
            ""
        }
    override val bounds: NodeBounds
        get() {
            val r = Rect()
            try {
                node.getBoundsInScreen(r)
            } catch (_: Throwable) {
            }
            return NodeBounds(r.left, r.top, r.right, r.bottom)
        }
}

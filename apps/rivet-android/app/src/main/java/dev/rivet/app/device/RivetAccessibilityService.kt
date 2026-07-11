package dev.rivet.app.device

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

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

    private var lastRoot: AccessibilityNodeInfo? = null
    private var lastPackage: String? = null
    private var server: ControlServer? = null

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

    fun dumpUiTree(includeBounds: Boolean = true, maxDepth: Int = 12): JSONObject {
        val root = lastRoot ?: rootInActiveWindow
        val json = JSONObject()
        json.put("package", lastPackage ?: root?.packageName?.toString() ?: "unknown")
        json.put("timestamp", System.currentTimeMillis())
        val nodes = JSONArray()
        if (root != null) collectNodes(root, nodes, 0, maxDepth, includeBounds)
        json.put("nodes", nodes)
        return json
    }

    private fun collectNodes(node: AccessibilityNodeInfo, out: JSONArray, depth: Int, maxDepth: Int, includeBounds: Boolean) {
        if (depth > maxDepth) return
        val obj = JSONObject()
        obj.put("class", node.className?.toString() ?: "")
        obj.put("text", node.text?.toString() ?: "")
        obj.put("contentDescription", node.contentDescription?.toString() ?: "")
        obj.put("viewId", node.viewIdResourceName ?: "")
        obj.put("clickable", node.isClickable)
        obj.put("focusable", node.isFocusable)
        obj.put("focused", node.isFocused)
        obj.put("scrollable", node.isScrollable)
        obj.put("enabled", node.isEnabled)
        obj.put("checked", node.isChecked)
        obj.put("selected", node.isSelected)
        obj.put("visible", node.isVisibleToUser)
        if (includeBounds) {
            val r = Rect(); node.getBoundsInScreen(r)
            val b = JSONObject()
            b.put("left", r.left); b.put("top", r.top); b.put("right", r.right); b.put("bottom", r.bottom)
            b.put("width", r.width()); b.put("height", r.height())
            obj.put("bounds", b)
        }
        out.put(obj)
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collectNodes(child, out, depth + 1, maxDepth, includeBounds)
            child.recycle()
        }
    }

    fun tap(x: Int, y: Int, durationMs: Long = 60): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build()
        return dispatchGesture(gesture, null, null)
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long = 250): Boolean {
        val path = Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build()
        return dispatchGesture(gesture, null, null)
    }

    fun typeText(text: String): Boolean {
        val root = lastRoot ?: rootInActiveWindow ?: return false
        var target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (target == null || !target.isFocused) target = findFirstEditable(root)
        if (target == null) return false
        val args = Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
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
        val root = lastRoot ?: rootInActiveWindow ?: return false
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
}

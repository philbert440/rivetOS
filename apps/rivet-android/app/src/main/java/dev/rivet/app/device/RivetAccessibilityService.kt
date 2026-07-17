package dev.rivet.app.device

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
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

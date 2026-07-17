package dev.rivet.app.device

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import dev.rivet.app.AGENT_ALERT_NOTIFICATION_CHANNEL_ID
import dev.rivet.app.RouteActivity
import dev.rivet.app.runtime.RivetRuntime
import dev.rivet.app.utils.sendNotification
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Tiny, dependency-free HTTP/JSON control server. Binds 127.0.0.1:9876 (loopback only)
 * so it is unreachable from the network. On-device agents (Claude/Grok in Termux) drive it
 * over loopback; a desktop can use `adb forward tcp:9876 tcp:9876`.
 *
 * Every endpoint except GET /status requires X-Rivet-Token == [DeviceControl.getControlToken].
 * Endpoints:
 *   GET  /status
 *   GET  /ui
 *   GET  /screenshot
 *   POST /action   {type: click|swipe|text|global|node_click|node_action|launch|intent}
 *   POST /notify   {title, body?, url?, id?} post a high-priority agent alert notification
 *   POST /mode     {mode: full|eyes|parked}
 *   POST /exec      -- {cmd:[..], env:{..}, cwd, timeoutMs} run argv under our uid (control path)
 */
class ControlServer(private val context: Context) {

    private var serverSocket: ServerSocket? = null
    private val executor = Executors.newCachedThreadPool()
    private val screenshotLimiter = ScreenshotRateLimiter()

    fun start() {
        thread(isDaemon = true, name = "RivetControlServer") {
            try {
                serverSocket = ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress("127.0.0.1", DeviceControl.CONTROL_PORT))
                }
                Log.i(DeviceControl.TAG, "ControlServer on 127.0.0.1:${DeviceControl.CONTROL_PORT} (loopback only)")
                while (!serverSocket!!.isClosed) {
                    val client = serverSocket!!.accept()
                    executor.submit { handleClient(client) }
                }
            } catch (e: Exception) {
                if (serverSocket?.isClosed == false) Log.e(DeviceControl.TAG, "ControlServer crashed", e)
            }
        }
    }

    fun stop() {
        try { serverSocket?.close() } catch (_: Exception) {}
        executor.shutdownNow()
    }

    private fun handleClient(socket: Socket) {
        socket.use { s ->
            try {
                val reader = BufferedReader(InputStreamReader(s.getInputStream()))
                val requestLine = reader.readLine() ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 2) return
                val method = parts[0]
                val (path, query) = parseUrl(parts[1])

                var line: String
                var contentLength = 0
                var token: String? = null
                while (true) {
                    line = reader.readLine() ?: break
                    val lower = line.lowercase()
                    if (lower.startsWith("content-length:")) contentLength = line.substringAfter(":").trim().toIntOrNull() ?: 0
                    if (lower.startsWith("x-rivet-token:")) token = line.substringAfter(":").trim()
                    if (line.isEmpty()) break
                }
                val body = if (contentLength > 0) {
                    val buf = CharArray(contentLength); reader.read(buf, 0, contentLength); String(buf)
                } else ""

                // Debug-only fixed fallback token so remote diagnosis via /exec doesn't depend on
                // the per-install token being published to /sdcard (which needs All-Files-Access).
                // The `BuildConfig.DEBUG &&` short-circuits to a compile-time constant in release,
                // so R8 dead-code-eliminates this backdoor from any non-debug build.
                val devToken = dev.rivet.app.BuildConfig.DEBUG && token == dev.rivet.app.data.datastore.RIVET_BRIDGE_TOKEN
                val authed = path == "/status" || token == DeviceControl.getControlToken(context) || devToken
                val response = when {
                    !authed -> errorResponse(401, "unauthorized", "missing or invalid X-Rivet-Token")
                    method == "GET" && path == "/status" -> handleStatus(query)
                    method == "GET" && path == "/ui" -> handleUi(query)
                    method == "GET" && path == "/screenshot" -> handleScreenshot(query)
                    method == "POST" && path == "/action" -> handleAction(body, query)
                    method == "POST" && path == "/notify" -> handleNotify(body, query)
                    method == "POST" && path == "/mode" -> handleMode(body, query)
                    // /exec runs arbitrary argv under our uid — a diagnostic spike. DEBUG-only so
                    // release builds carry no arbitrary-exec endpoint at all (defense in depth on
                    // top of the loopback bind + token guard).
                    method == "POST" && path == "/exec" && dev.rivet.app.BuildConfig.DEBUG -> handleExec(body, query)
                    else -> errorResponse(404, "not_found", "not found: $path")
                }
                writeResponse(s.getOutputStream(), response)
            } catch (e: Exception) {
                Log.e(DeviceControl.TAG, "client error", e)
            }
        }
    }

    private fun currentMode(): ControlMode =
        ControlMode.parse(DeviceControl.getControlMode(context)) ?: ControlMode.FULL

    private fun modeGate(endpoint: ControlEndpoint): HttpResponse? {
        val mode = currentMode()
        if (!isEndpointAllowed(endpoint, mode)) {
            return forbiddenModeResponse(mode, endpoint)
        }
        return null
    }

    @Suppress("UNUSED_PARAMETER")
    private fun handleStatus(query: Map<String, String>): HttpResponse {
        val acc = RivetAccessibilityService.getInstance()
        val mode = currentMode()
        val json = JSONObject()
        json.put("ok", true)
        json.put("package", context.packageName)
        json.put("accessibility_connected", acc != null)
        json.put("current_package", acc?.getCurrentPackage())
        json.put("port", DeviceControl.CONTROL_PORT)
        json.put("version", "0.2.0")
        json.put("mode", mode.wire)
        json.put(
            "capabilities",
            buildCapabilitiesJson(
                screenshotSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R,
                execEnabled = dev.rivet.app.BuildConfig.DEBUG,
            ),
        )
        // Best-effort display metrics; omit on failure.
        runCatching {
            val dm = context.resources.displayMetrics
            json.put(
                "display",
                JSONObject()
                    .put("width", dm.widthPixels)
                    .put("height", dm.heightPixels)
                    .put("densityDpi", dm.densityDpi),
            )
        }
        // Mesh VPN: surface this device's WG public key (generated + persisted on first read) so the
        // relay peer on rivet-prod can be configured, plus the live tunnel status. Private key never leaves.
        json.put("wg_configured", dev.rivet.app.net.RivetVpn.isConfigured)
        runCatching { json.put("wg_public_key", dev.rivet.app.net.RivetVpn.publicKeyBase64(context)) }
        json.put("wg_status", dev.rivet.app.net.RivetVpn.status.value.name)
        json.put("timestamp", System.currentTimeMillis())
        return jsonResponse(200, json)
    }

    private fun handleUi(query: Map<String, String>): HttpResponse {
        modeGate(ControlEndpoint.UI)?.let { return it }
        val acc = RivetAccessibilityService.getInstance()
            ?: return errorResponse(503, "a11y_disconnected", "accessibility service not connected")
        val parsed = when (val p = parseUiQuery(query)) {
            is ParseUiQueryResult.BadRequest ->
                return errorResponse(400, "bad_request", p.message)
            is ParseUiQueryResult.Ok -> p.query
        }
        return try {
            jsonResponse(
                200,
                acc.dumpUiTree(
                    format = parsed.format,
                    includeBounds = parsed.includeBounds,
                    maxDepth = parsed.maxDepth,
                    limit = parsed.limit,
                    filters = parsed.filters,
                    fields = parsed.fields,
                ),
            )
        } catch (e: Exception) {
            errorResponse(500, "internal_error", "dump failed: ${e.message}")
        }
    }

    @Suppress("UNUSED_PARAMETER")
    private fun handleScreenshot(query: Map<String, String>): HttpResponse {
        return runScreenshotRoute(
            mode = currentMode(),
            query = query,
            limiter = screenshotLimiter,
            capture = { params ->
                val acc = RivetAccessibilityService.getInstance()
                    ?: return@runScreenshotRoute ScreenshotOutcome.Error(
                        "a11y_disconnected",
                        "accessibility service not connected",
                    )
                acc.takeScaledScreenshot(
                    scale = params.scale,
                    quality = params.quality,
                    displayId = params.displayId,
                    timeoutMs = params.timeoutMs,
                )
            },
            writeFile = { bytes ->
                try {
                    val hostFile = File(
                        RivetRuntime.rootfsDir(context),
                        "home/rivet/.rivet/screenshots/last.jpg",
                    )
                    hostFile.parentFile?.mkdirs()
                    hostFile.writeBytes(bytes)
                    true
                } catch (t: Throwable) {
                    Log.e(DeviceControl.TAG, "last.jpg write failed: ${t.message}")
                    false
                }
            },
        )
    }

    @Suppress("UNUSED_PARAMETER")
    private fun handleMode(body: String, query: Map<String, String>): HttpResponse {
        // Always allowed (even parked) so the kill-switch can be released.
        return try {
            val req = JSONObject(body)
            val mode = req.getString("mode").lowercase()
            if (ControlMode.parse(mode) == null) {
                return errorResponse(400, "bad_request", "mode must be full|eyes|parked")
            }
            DeviceControl.setControlMode(context, mode)
            jsonResponse(
                200,
                JSONObject().put("ok", true).put("mode", mode),
            )
        } catch (e: Exception) {
            errorResponse(400, "bad_request", "bad mode: ${e.message}")
        }
    }

    /** SPIKE: run an arbitrary argv under RivetHub's uid. Loopback + token-guarded. */
    @Suppress("UNUSED_PARAMETER")
    private fun handleExec(body: String, query: Map<String, String>): HttpResponse {
        modeGate(ControlEndpoint.EXEC)?.let { return it }
        return try {
            val req = JSONObject(body)
            val arr = req.getJSONArray("cmd")
            val cmd = (0 until arr.length()).map { arr.getString(it) }
            val env = req.optJSONObject("env")?.let { o ->
                o.keys().asSequence().associateWith { k -> o.getString(k) }
            }
            val cwd = if (req.has("cwd")) req.getString("cwd") else null
            val timeoutMs = req.optLong("timeoutMs", 20000)
            jsonResponse(200, DeviceControl.runExec(cmd, env, cwd, timeoutMs).put("code", 200))
        } catch (e: Exception) {
            errorResponse(400, "bad_request", "bad exec: ${e.message}")
        }
    }

    @Suppress("UNUSED_PARAMETER")
    private fun handleNotify(body: String, query: Map<String, String>): HttpResponse {
        // /notify always allowed in all modes (agent alerts still useful when parked).
        return try {
            val req = JSONObject(body)
            val title = req.getString("title")
            val text = req.optString("body", req.optString("text", ""))
            val url = req.optString("url", null)?.takeIf { it.isNotBlank() }
            val notificationId = if (req.has("id")) {
                req.getInt("id")
            } else {
                (req.optString("tag", title).hashCode() and 0x7fffffff) % 40_000 + 50_000
            }

            val launchIntent = if (url != null) {
                Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            } else {
                Intent(context, RouteActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
            }
            val pendingIntent = PendingIntent.getActivity(
                context,
                notificationId,
                launchIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )

            val posted = context.sendNotification(
                channelId = AGENT_ALERT_NOTIFICATION_CHANNEL_ID,
                notificationId = notificationId
            ) {
                this.title = title
                content = text
                autoCancel = true
                useDefaults = true
                useBigTextStyle = text.length > 64
                category = NotificationCompat.CATEGORY_RECOMMENDATION
                contentIntent = pendingIntent
            }

            jsonResponse(
                200,
                JSONObject()
                    .put("ok", posted)
                    .put("notification_id", notificationId)
                    .put("posted", posted)
                    .put("reason", if (posted) null else "notification permission not granted")
                    .put("executed_at", System.currentTimeMillis()),
            )
        } catch (e: Exception) {
            errorResponse(400, "bad_request", "bad notify: ${e.message}")
        }
    }

    @Suppress("UNUSED_PARAMETER")
    private fun handleAction(body: String, query: Map<String, String>): HttpResponse {
        modeGate(ControlEndpoint.ACTION)?.let { return it }
        val acc = RivetAccessibilityService.getInstance()
            ?: return errorResponse(
                503,
                "a11y_disconnected",
                "accessibility service not connected — enable it in Settings",
            )
        return try {
            val req = JSONObject(body)
            val type = req.optString("type", "")
            val waitParams = parseActionWaitParams(req)
            when (type) {
                "click" -> {
                    val outcome = acc.tap(
                        x = req.getInt("x"),
                        y = req.getInt("y"),
                        wait = waitParams.wait,
                        timeoutMs = waitParams.timeoutMs,
                    )
                    mapGestureOutcomeToHttp(type, waitParams.wait, outcome)
                }
                "swipe" -> {
                    val outcome = acc.swipe(
                        x1 = req.getInt("x1"),
                        y1 = req.getInt("y1"),
                        x2 = req.getInt("x2"),
                        y2 = req.getInt("y2"),
                        durationMs = req.optLong("duration", 280),
                        wait = waitParams.wait,
                        timeoutMs = waitParams.timeoutMs,
                    )
                    mapGestureOutcomeToHttp(type, waitParams.wait, outcome)
                }
                "text" -> mapNonGestureActionToHttp(type, acc.typeText(req.getString("text")))
                "global" -> {
                    val code = when (req.getString("action").uppercase()) {
                        "BACK" -> AccessibilityServiceGlobals.BACK
                        "HOME" -> AccessibilityServiceGlobals.HOME
                        "RECENTS" -> AccessibilityServiceGlobals.RECENTS
                        "NOTIFICATIONS" -> AccessibilityServiceGlobals.NOTIFICATIONS
                        "QUICK_SETTINGS" -> AccessibilityServiceGlobals.QUICK_SETTINGS
                        else -> -1
                    }
                    val ok = if (code >= 0) acc.performGlobal(code) else false
                    mapNonGestureActionToHttp(type, ok)
                }
                "node_click" -> mapNonGestureActionToHttp(
                    type,
                    acc.clickNodeContainingText(req.getString("text"), req.optString("package", null)),
                )
                "node_action" -> {
                    val nodeId = req.optString("nodeId", "").trim()
                    if (nodeId.isEmpty()) {
                        return errorResponse(400, "bad_request", "nodeId is required")
                    }
                    val action = req.optString("action", "")
                    if (action != "click") {
                        return errorResponse(
                            400,
                            "bad_request",
                            "action must be \"click\" (richer node actions not yet supported)",
                        )
                    }
                    val outcome = acc.nodeClick(nodeId, timeoutMs = waitParams.timeoutMs)
                    mapNodeActionClickToHttp(nodeId, outcome)
                }
                "launch" -> {
                    val intent = context.packageManager.getLaunchIntentForPackage(req.getString("package"))
                    val ok = if (intent != null) {
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(intent)
                        true
                    } else {
                        false
                    }
                    mapNonGestureActionToHttp(type, ok)
                }
                "intent" -> {
                    val i = Intent(req.optString("action", Intent.ACTION_VIEW))
                    if (req.has("data")) i.data = Uri.parse(req.getString("data"))
                    if (req.has("package")) i.setPackage(req.getString("package"))
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    val ok = try {
                        context.startActivity(i)
                        true
                    } catch (_: Exception) {
                        false
                    }
                    mapNonGestureActionToHttp(type, ok)
                }
                else -> errorResponse(400, "bad_request", "unknown action type: $type")
            }
        } catch (e: Exception) {
            errorResponse(400, "bad_request", "bad action: ${e.message}")
        }
    }
}

private object AccessibilityServiceGlobals {
    const val BACK = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK
    const val HOME = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME
    const val RECENTS = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_RECENTS
    const val NOTIFICATIONS = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
    const val QUICK_SETTINGS = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
}

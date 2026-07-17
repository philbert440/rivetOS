package dev.rivet.app.device

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Base64

// ---------------------------------------------------------------------------
// Control modes
// ---------------------------------------------------------------------------

enum class ControlMode(val wire: String) {
    FULL("full"),
    EYES("eyes"),
    PARKED("parked");

    companion object {
        fun parse(s: String?): ControlMode? = when (s?.lowercase()) {
            "full" -> FULL
            "eyes" -> EYES
            "parked" -> PARKED
            else -> null
        }

        val ALL_WIRE = listOf("full", "eyes", "parked")
    }
}

/**
 * Control endpoints that participate in the mode matrix.
 * [MODE] is always allowed (so Phil can unpark); [STATUS]/[NOTIFY] always allowed.
 */
enum class ControlEndpoint {
    STATUS,
    UI,
    SCREENSHOT,
    ACTION,
    NOTIFY,
    EXEC,
    MODE,
    WAIT,
}

/**
 * Pure mode gate: endpoint × mode → allowed.
 * Matrix from Fidelity T1.1b; `/exec` treated like an action (blocked in eyes/parked).
 */
fun isEndpointAllowed(endpoint: ControlEndpoint, mode: ControlMode): Boolean = when (endpoint) {
    ControlEndpoint.STATUS, ControlEndpoint.NOTIFY, ControlEndpoint.MODE -> true
    ControlEndpoint.UI, ControlEndpoint.SCREENSHOT -> mode != ControlMode.PARKED
    ControlEndpoint.ACTION, ControlEndpoint.EXEC, ControlEndpoint.WAIT -> mode == ControlMode.FULL
}

fun forbiddenModeResponse(mode: ControlMode, endpoint: ControlEndpoint): HttpResponse =
    errorResponse(
        403,
        "forbidden_mode",
        "control mode '${mode.wire}' blocks ${endpoint.name.lowercase()}",
    )

// ---------------------------------------------------------------------------
// Screenshot query parsing
// ---------------------------------------------------------------------------

const val SCREENSHOT_GUEST_PATH = "/home/rivet/.rivet/screenshots/last.jpg"
const val SCREENSHOT_DEFAULT_TIMEOUT_MS = 5_000L
const val SCREENSHOT_MAX_TIMEOUT_MS = 15_000L
const val SCREENSHOT_MAX_EDGE = 1280

data class ScreenshotRequestParams(
    val scale: Float,
    val quality: Int,
    val format: String,
    val displayId: Int,
    val dest: String,
    val includeBase64: Boolean,
    val timeoutMs: Long = SCREENSHOT_DEFAULT_TIMEOUT_MS,
)

sealed class ParseScreenshotResult {
    data class Ok(val params: ScreenshotRequestParams) : ParseScreenshotResult()
    data class BadRequest(val message: String) : ParseScreenshotResult()
}

/**
 * Parse + validate GET /screenshot query params.
 * Defaults: scale 0.4, quality 70, format jpeg, display 0, dest file, include_base64 0.
 * Clamps scale to [0.1, 1.0] and quality to [1, 100]. Unknown dest/format → bad_request.
 */
fun parseScreenshotQuery(query: Map<String, String>): ParseScreenshotResult {
    val scaleRaw = query["scale"]?.toFloatOrNull() ?: 0.4f
    val qualityRaw = query["quality"]?.toIntOrNull() ?: 70
    val format = (query["format"] ?: "jpeg").lowercase()
    val displayId = query["display"]?.toIntOrNull() ?: 0
    val dest = (query["dest"] ?: "file").lowercase()
    val includeBase64 = when (query["include_base64"]?.lowercase()) {
        "1", "true", "yes" -> true
        else -> false
    }
    val timeoutRaw = query["timeout_ms"]?.toLongOrNull() ?: SCREENSHOT_DEFAULT_TIMEOUT_MS

    if (format != "jpeg") {
        return ParseScreenshotResult.BadRequest("format must be jpeg (got '$format')")
    }
    if (dest !in setOf("file", "json", "raw")) {
        return ParseScreenshotResult.BadRequest("dest must be file|json|raw (got '$dest')")
    }

    val scale = scaleRaw.coerceIn(0.1f, 1.0f)
    val quality = qualityRaw.coerceIn(1, 100)
    val timeoutMs = timeoutRaw.coerceIn(1L, SCREENSHOT_MAX_TIMEOUT_MS)

    return ParseScreenshotResult.Ok(
        ScreenshotRequestParams(
            scale = scale,
            quality = quality,
            format = format,
            displayId = displayId,
            dest = dest,
            includeBase64 = includeBase64,
            timeoutMs = timeoutMs,
        ),
    )
}

// ---------------------------------------------------------------------------
// Screenshot outcome (shared service ↔ HTTP mapping)
// ---------------------------------------------------------------------------

sealed class ScreenshotOutcome {
    data class Success(
        val bytes: ByteArray,
        val width: Int,
        val height: Int,
        val scaleApplied: Float,
    ) : ScreenshotOutcome() {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Success) return false
            return width == other.width &&
                height == other.height &&
                scaleApplied == other.scaleApplied &&
                bytes.contentEquals(other.bytes)
        }

        override fun hashCode(): Int {
            var r = bytes.contentHashCode()
            r = 31 * r + width
            r = 31 * r + height
            r = 31 * r + scaleApplied.hashCode()
            return r
        }
    }

    data class Error(val error: String, val message: String) : ScreenshotOutcome()
    data object Unsupported : ScreenshotOutcome()
}

// ---------------------------------------------------------------------------
// Screenshot route (gate order: mode → rate → capture)
// ---------------------------------------------------------------------------

/**
 * Normative GET /screenshot handling after auth.
 * Order: mode gate → rate limit + encode slot → [capture] → response.
 * Parked / rate-limited paths must not invoke [capture] (no framebuffer / last.jpg).
 *
 * @param writeFile host write for dest=file; returns false on IO failure
 */
fun runScreenshotRoute(
    mode: ControlMode,
    query: Map<String, String>,
    limiter: ScreenshotRateLimiter,
    capture: (ScreenshotRequestParams) -> ScreenshotOutcome,
    writeFile: (ByteArray) -> Boolean = { true },
    nowMs: () -> Long = { System.currentTimeMillis() },
): HttpResponse {
    // 1) Mode gate — before any capture
    if (!isEndpointAllowed(ControlEndpoint.SCREENSHOT, mode)) {
        return forbiddenModeResponse(mode, ControlEndpoint.SCREENSHOT)
    }

    // 2) Parse params (cheap; still before capture so bad requests never touch FB)
    val parsed = when (val p = parseScreenshotQuery(query)) {
        is ParseScreenshotResult.BadRequest ->
            return errorResponse(400, "bad_request", p.message)
        is ParseScreenshotResult.Ok -> p.params
    }

    // 3) Rate limit + encode slot
    val acquired = limiter.tryAcquire()
    if (!acquired.allowed) {
        val retryMs = acquired.retryAfterMs.coerceAtLeast(1L)
        val retrySec = retryAfterSeconds(retryMs)
        return errorResponse(
            code = 429,
            error = "rate_limited",
            message = "screenshot rate limit exceeded",
            extra = JSONObject().put("retry_after_ms", retryMs),
            headers = mapOf("Retry-After" to retrySec.toString()),
        )
    }

    try {
        // 4) Capture
        return when (val outcome = capture(parsed)) {
            is ScreenshotOutcome.Unsupported ->
                errorResponse(501, "unsupported", "screenshot requires API 30+")

            is ScreenshotOutcome.Error -> mapScreenshotError(outcome)

            is ScreenshotOutcome.Success ->
                buildScreenshotSuccess(parsed, outcome, writeFile, nowMs())
        }
    } finally {
        limiter.releaseEncode()
    }
}

fun mapScreenshotError(err: ScreenshotOutcome.Error): HttpResponse {
    return when (err.error) {
        "a11y_disconnected", "no_accessibility_access" ->
            errorResponse(503, err.error, err.message)
        "invalid_display" ->
            errorResponse(400, err.error, err.message)
        "interval_interval" -> {
            val retryMs = 500L
            errorResponse(
                429,
                err.error,
                err.message,
                extra = JSONObject().put("retry_after_ms", retryMs),
                headers = mapOf("Retry-After" to "1"),
            )
        }
        "internal_error" ->
            errorResponse(500, err.error, err.message)
        // Expected capture failures: HTTP 200 + ok:false so agents branch on JSON
        "secure_window", "timed_out" ->
            jsonResponse(
                200,
                JSONObject()
                    .put("ok", false)
                    .put("error", err.error)
                    .put("message", err.message)
                    .put("code", 200),
            )
        else ->
            jsonResponse(
                200,
                JSONObject()
                    .put("ok", false)
                    .put("error", err.error)
                    .put("message", err.message)
                    .put("code", 200),
            )
    }
}

private fun buildScreenshotSuccess(
    params: ScreenshotRequestParams,
    ok: ScreenshotOutcome.Success,
    writeFile: (ByteArray) -> Boolean,
    capturedAt: Long,
): HttpResponse {
    val sha = sha256Hex(ok.bytes)
    val b64 = if (params.dest == "json" || params.includeBase64) {
        Base64.getEncoder().encodeToString(ok.bytes)
    } else {
        null
    }

    when (params.dest) {
        "raw" -> {
            return HttpResponse(
                code = 200,
                contentType = "image/jpeg",
                body = ok.bytes,
                headers = mapOf(
                    "X-Rivet-Width" to ok.width.toString(),
                    "X-Rivet-Height" to ok.height.toString(),
                    "X-Rivet-Scale" to ok.scaleApplied.toString(),
                ),
            )
        }
        "file" -> {
            if (!writeFile(ok.bytes)) {
                return errorResponse(500, "internal_error", "failed to write last.jpg")
            }
        }
        // "json" — no file write
    }

    val body = JSONObject()
        .put("ok", true)
        .put("width", ok.width)
        .put("height", ok.height)
        .put("scale", ok.scaleApplied.toDouble())
        .put("format", "jpeg")
        .put("bytes", ok.bytes.size)
        .put("sha256", sha)
        .put("captured_at", capturedAt)
        .put("display_id", params.displayId)

    if (params.dest == "file") {
        body.put("path", SCREENSHOT_GUEST_PATH)
    }
    if (b64 != null) {
        body.put("base64", b64)
    }
    return jsonResponse(200, body)
}

fun sha256Hex(bytes: ByteArray): String {
    val dig = MessageDigest.getInstance("SHA-256").digest(bytes)
    val sb = StringBuilder(dig.size * 2)
    for (b in dig) {
        sb.append(String.format("%02x", b))
    }
    return sb.toString()
}

/** Build nested capabilities object for GET /status (schema 1 / PR1b surface). */
fun buildCapabilitiesJson(screenshotSupported: Boolean, execEnabled: Boolean): JSONObject {
    val shot = JSONObject()
        .put("supported", screenshotSupported)
        .put("minApi", 30)
        .put("dest", JSONArray().put("file").put("json").put("raw"))
    val ui = JSONObject()
        .put("formats", JSONArray().put("flat"))
        .put("node_id", true) // PR3a
        .put("filters", false)
    return JSONObject()
        .put("schema", 1)
        .put("screenshot", shot)
        .put("gesture_wait", true)
        .put("ui", ui)
        .put("wait", false)
        .put("clipboard", false)
        .put("notifications_read", false)
        .put("exec", execEnabled)
        .put("modes", JSONArray().put("full").put("eyes").put("parked"))
}

/** Map AccessibilityService.takeScreenshot platform error codes → stable error strings. */
fun mapTakeScreenshotErrorCode(errorCode: Int): Pair<String, String> = when (errorCode) {
    // AccessibilityService.ERROR_TAKE_SCREENSHOT_* (API 30+ / 34+)
    1 -> "internal_error" to "screenshot internal error"
    2 -> "no_accessibility_access" to "no accessibility access for screenshot (re-toggle a11y after upgrade?)"
    3 -> "interval_interval" to "platform screenshot interval too short"
    4 -> "invalid_display" to "invalid display id"
    // ERROR_TAKE_SCREENSHOT_INVALID_WINDOW = 5 (API 34)
    5 -> "internal_error" to "invalid window for screenshot"
    // ERROR_TAKE_SCREENSHOT_SECURE_WINDOW = 6 (API 34)
    6 -> "secure_window" to "secure window blocks screenshot"
    else -> "internal_error" to "screenshot failed (code $errorCode)"
}

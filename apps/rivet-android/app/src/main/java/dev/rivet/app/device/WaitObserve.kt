package dev.rivet.app.device

import org.json.JSONObject
import java.util.concurrent.Semaphore

// ---------------------------------------------------------------------------
// POST /wait — pure condition eval, param parse, concurrency limiter
// ---------------------------------------------------------------------------

const val WAIT_DEFAULT_TIMEOUT_MS = 8_000L
const val WAIT_MAX_TIMEOUT_MS = 30_000L
const val WAIT_DEFAULT_INTERVAL_MS = 250L
const val WAIT_MIN_INTERVAL_MS = 50L
const val WAIT_MAX_CONCURRENT = 5
/** Backoff when concurrent wait slots are full (not a token-bucket window). */
const val WAIT_CONCURRENT_RETRY_AFTER_MS = 500L

/** Labels for one visible a11y node (text + contentDescription). */
data class WaitNodeLabels(
    val text: String = "",
    val contentDescription: String = "",
)

/** Point-in-time UI state for pure condition evaluation. */
data class WaitSnapshot(
    val nodes: List<WaitNodeLabels>,
    val currentPackage: String?,
)

/** Parsed /wait body after clamps. At least one of text / package / gone is non-null. */
data class WaitRequestParams(
    val text: String?,
    val packageEquals: String?,
    val gone: String?,
    val timeoutMs: Long,
    val intervalMs: Long,
)

sealed class ParseWaitResult {
    data class Ok(val params: WaitRequestParams) : ParseWaitResult()
    data class BadRequest(val message: String) : ParseWaitResult()
}

/**
 * Case-insensitive substring match on [WaitNodeLabels.text] or
 * [WaitNodeLabels.contentDescription] — same semantics as `/ui` `text` filter.
 */
fun nodeLabelsContain(labels: WaitNodeLabels, query: String): Boolean {
    if (query.isEmpty()) return false
    return labels.text.contains(query, ignoreCase = true) ||
        labels.contentDescription.contains(query, ignoreCase = true)
}

fun anyVisibleNodeContains(nodes: List<WaitNodeLabels>, query: String): Boolean {
    for (n in nodes) {
        if (nodeLabelsContain(n, query)) return true
    }
    return false
}

/**
 * Pure condition evaluation over a snapshot.
 *
 * Conditions are OR'd: any provided condition that holds counts as success.
 * When several hold, priority for [matched] is **text → package → gone**.
 *
 * @return wire name `"text"` | `"package"` | `"gone"`, or null if none hold.
 */
fun evaluateWaitCondition(snapshot: WaitSnapshot, params: WaitRequestParams): String? {
    params.text?.let { q ->
        if (anyVisibleNodeContains(snapshot.nodes, q)) return "text"
    }
    params.packageEquals?.let { pkg ->
        if (snapshot.currentPackage != null && snapshot.currentPackage == pkg) return "package"
    }
    params.gone?.let { q ->
        if (!anyVisibleNodeContains(snapshot.nodes, q)) return "gone"
    }
    return null
}

/**
 * Parse + clamp POST /wait JSON body.
 *
 * - At least one of `text`, `package`, `gone` required (non-empty string).
 * - `timeoutMs` default 8000, clamped to [1, 30000].
 * - `intervalMs` default 250, min 50 (no upper clamp beyond timeout scale).
 */
fun parseWaitBody(body: JSONObject): ParseWaitResult {
    val text = body.optString("text", "").trim().takeIf { it.isNotEmpty() }
    val packageEquals = body.optString("package", "").trim().takeIf { it.isNotEmpty() }
    val gone = body.optString("gone", "").trim().takeIf { it.isNotEmpty() }

    if (text == null && packageEquals == null && gone == null) {
        return ParseWaitResult.BadRequest("at least one of text|package|gone is required")
    }

    val timeoutRaw = if (body.has("timeoutMs")) {
        body.optLong("timeoutMs", WAIT_DEFAULT_TIMEOUT_MS)
    } else {
        WAIT_DEFAULT_TIMEOUT_MS
    }
    val intervalRaw = if (body.has("intervalMs")) {
        body.optLong("intervalMs", WAIT_DEFAULT_INTERVAL_MS)
    } else {
        WAIT_DEFAULT_INTERVAL_MS
    }

    val timeoutMs = timeoutRaw.coerceIn(1L, WAIT_MAX_TIMEOUT_MS)
    val intervalMs = intervalRaw.coerceAtLeast(WAIT_MIN_INTERVAL_MS)

    return ParseWaitResult.Ok(
        WaitRequestParams(
            text = text,
            packageEquals = packageEquals,
            gone = gone,
            timeoutMs = timeoutMs,
            intervalMs = intervalMs,
        ),
    )
}

/** Success envelope for POST /wait. */
fun waitSuccessResponse(
    matched: String,
    waitedMs: Long,
    currentPackage: String?,
): HttpResponse {
    val body = JSONObject()
        .put("ok", true)
        .put("matched", matched)
        .put("waitedMs", waitedMs)
        .put("current_package", currentPackage)
    return jsonResponse(200, body)
}

/** Timeout envelope: HTTP 200 + ok:false + timed_out (agent-branchable). */
fun waitTimeoutResponse(waitedMs: Long): HttpResponse {
    return jsonResponse(
        200,
        JSONObject()
            .put("ok", false)
            .put("error", "timed_out")
            .put("message", "wait condition not met before timeout")
            .put("waitedMs", waitedMs)
            .put("code", 200),
    )
}

/**
 * Concurrent-slot limiter for POST /wait (default max 5).
 * Pure Kotlin — Semaphore-backed; no Android deps. 6th tryAcquire → not allowed.
 */
class WaitConcurrencyLimiter(
    private val maxConcurrent: Int = WAIT_MAX_CONCURRENT,
    private val retryAfterMs: Long = WAIT_CONCURRENT_RETRY_AFTER_MS,
) {
    private val slots = Semaphore(maxConcurrent.coerceAtLeast(1))

    data class AcquireResult(
        val allowed: Boolean,
        /** Milliseconds until a retry may succeed; 0 when allowed. */
        val retryAfterMs: Long = 0,
    )

    /**
     * Non-blocking acquire. On success caller **must** [release] when the wait finishes
     * (including timeout / error paths).
     */
    fun tryAcquire(): AcquireResult {
        if (slots.tryAcquire()) {
            return AcquireResult(allowed = true)
        }
        return AcquireResult(allowed = false, retryAfterMs = retryAfterMs.coerceAtLeast(1L))
    }

    fun release() {
        slots.release()
    }

    /** Exposed for tests. */
    fun availablePermits(): Int = slots.availablePermits()
}

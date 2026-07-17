package dev.rivet.app.device

import org.json.JSONObject
import java.util.ArrayDeque

/**
 * Centralized soft rate limits for control endpoints (PR8).
 *
 * | Endpoint     | Soft limit                          | Implementation              |
 * |--------------|-------------------------------------|-----------------------------|
 * | /screenshot  | 2/s, 30/min, 1 concurrent encode    | [ScreenshotRateLimiter]     |
 * | /action      | 20/s                                | this registry               |
 * | /ui          | 10/s                                | this registry               |
 * | /wait        | 5 concurrent                        | [WaitConcurrencyLimiter]    |
 *
 * Screenshot keeps its dedicated limiter (encode slot + dual window) so we do **not**
 * double-limit it here. Keys are stable endpoint path suffixes without leading slash.
 */

const val ACTION_RATE_PER_SECOND = 20
const val UI_RATE_PER_SECOND = 10

/** Sliding-window token limiter: at most [perWindow] acquires per [windowMs]. */
class SlidingWindowRateLimiter(
    private val perWindow: Int,
    private val windowMs: Long = 1_000L,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) {
    private val lock = Any()
    private val stamps = ArrayDeque<Long>()

    data class AcquireResult(
        val allowed: Boolean,
        /** Milliseconds until a retry may succeed; 0 when allowed. */
        val retryAfterMs: Long = 0,
    )

    fun tryAcquire(): AcquireResult {
        synchronized(lock) {
            val now = clockMs()
            prune(now)
            if (stamps.size >= perWindow) {
                val oldest = stamps.first()
                val wait = (oldest + windowMs - now).coerceAtLeast(1L)
                return AcquireResult(allowed = false, retryAfterMs = wait)
            }
            stamps.addLast(now)
            return AcquireResult(allowed = true)
        }
    }

    /** How many stamps currently in the window (tests). */
    fun countInWindow(): Int = synchronized(lock) {
        prune(clockMs())
        stamps.size
    }

    private fun prune(now: Long) {
        val cutoff = now - windowMs
        while (stamps.isNotEmpty() && stamps.first() <= cutoff) {
            stamps.removeFirst()
        }
    }
}

/**
 * Registry of per-endpoint sliding-window limiters.
 * Screenshot is intentionally absent — use [ScreenshotRateLimiter] only.
 */
class RateLimitRegistry(
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    actionPerSecond: Int = ACTION_RATE_PER_SECOND,
    uiPerSecond: Int = UI_RATE_PER_SECOND,
) {
    private val actionLimiter = SlidingWindowRateLimiter(
        perWindow = actionPerSecond,
        windowMs = 1_000L,
        clockMs = clockMs,
    )
    private val uiLimiter = SlidingWindowRateLimiter(
        perWindow = uiPerSecond,
        windowMs = 1_000L,
        clockMs = clockMs,
    )

    /**
     * Try to acquire a token for [endpointKey] (`"action"` | `"ui"`).
     * Unknown keys are allowed (no limit).
     */
    fun tryAcquire(endpointKey: String): SlidingWindowRateLimiter.AcquireResult {
        return when (endpointKey) {
            "action" -> actionLimiter.tryAcquire()
            "ui" -> uiLimiter.tryAcquire()
            // screenshot deliberately not registered — handled by ScreenshotRateLimiter
            else -> SlidingWindowRateLimiter.AcquireResult(allowed = true)
        }
    }

    /** Test accessors. */
    fun actionCount(): Int = actionLimiter.countInWindow()
    fun uiCount(): Int = uiLimiter.countInWindow()
}

/**
 * Standard 429 rate_limited HTTP response with retry_after_ms + Retry-After header.
 */
fun rateLimitedResponse(
    message: String,
    retryAfterMs: Long,
): HttpResponse {
    val retryMs = retryAfterMs.coerceAtLeast(1L)
    val retrySec = retryAfterSeconds(retryMs)
    return errorResponse(
        code = 429,
        error = "rate_limited",
        message = message,
        extra = JSONObject().put("retry_after_ms", retryMs),
        headers = mapOf("Retry-After" to retrySec.toString()),
    )
}

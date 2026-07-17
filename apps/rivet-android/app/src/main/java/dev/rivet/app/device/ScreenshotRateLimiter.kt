package dev.rivet.app.device

import java.util.ArrayDeque
import java.util.concurrent.Semaphore

/**
 * Token-style dual sliding-window rate limiter for screenshots: max [perSecond] per 1s
 * and [perMinute] per 60s, plus a single concurrent encode slot (semaphore).
 *
 * Pure Kotlin — inject [clockMs] for deterministic JVM tests. Instantiated by [ControlServer].
 */
class ScreenshotRateLimiter(
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    private val perSecond: Int = 2,
    private val perMinute: Int = 30,
) {
    private val lock = Any()
    private val stamps = ArrayDeque<Long>()
    private val encodeSlot = Semaphore(1)

    data class AcquireResult(
        val allowed: Boolean,
        /** Milliseconds until a retry may succeed; 0 when allowed. */
        val retryAfterMs: Long = 0,
    )

    /**
     * Try to take a rate-limit token and the encode slot.
     * On failure neither is held. On success caller must [releaseEncode] when done.
     */
    fun tryAcquire(): AcquireResult {
        synchronized(lock) {
            val now = clockMs()
            prune(now)
            val retryMs = retryAfterMsLocked(now)
            if (retryMs > 0) {
                return AcquireResult(allowed = false, retryAfterMs = retryMs)
            }
            if (!encodeSlot.tryAcquire()) {
                // Another encode in flight — short backoff so clients can retry.
                return AcquireResult(allowed = false, retryAfterMs = 250L)
            }
            stamps.addLast(now)
            return AcquireResult(allowed = true)
        }
    }

    fun releaseEncode() {
        encodeSlot.release()
    }

    /** Exposed for tests: how many captures are counted in the last minute. */
    fun countInWindow(windowMs: Long = 60_000L): Int {
        synchronized(lock) {
            val now = clockMs()
            prune(now)
            val cutoff = now - windowMs
            return stamps.count { it > cutoff }
        }
    }

    private fun prune(now: Long) {
        val cutoff = now - 60_000L
        while (stamps.isNotEmpty() && stamps.first() <= cutoff) {
            stamps.removeFirst()
        }
    }

    private fun retryAfterMsLocked(now: Long): Long {
        val secCutoff = now - 1_000L
        val minCutoff = now - 60_000L
        val inSec = stamps.count { it > secCutoff }
        val inMin = stamps.count { it > minCutoff }
        var wait = 0L
        if (inSec >= perSecond) {
            val oldestInSec = stamps.firstOrNull { it > secCutoff } ?: return 0L
            wait = maxOf(wait, oldestInSec + 1_000L - now)
        }
        if (inMin >= perMinute) {
            val oldestInMin = stamps.firstOrNull { it > minCutoff } ?: return 0L
            wait = maxOf(wait, oldestInMin + 60_000L - now)
        }
        return if (wait < 1L && (inSec >= perSecond || inMin >= perMinute)) 1L else wait.coerceAtLeast(0L)
    }
}

/** HTTP Retry-After seconds from [retryAfterMs], rounded up (min 1 when limited). */
fun retryAfterSeconds(retryAfterMs: Long): Int {
    if (retryAfterMs <= 0L) return 0
    return ((retryAfterMs + 999L) / 1000L).toInt().coerceAtLeast(1)
}

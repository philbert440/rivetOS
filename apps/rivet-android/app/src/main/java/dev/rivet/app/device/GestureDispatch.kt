package dev.rivet.app.device

import org.json.JSONObject
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// ---------------------------------------------------------------------------
// Gesture result + single-flight queue (pure; JVM-testable)
// ---------------------------------------------------------------------------

/** Outcome of a waited (or fire-and-forget) gesture dispatch. */
data class GestureResult(
    val accepted: Boolean,
    val completed: Boolean,
    val cancelled: Boolean,
    val timedOut: Boolean,
    val durationMs: Long,
)

/**
 * Result of [dispatchGestureAwait]-style entry: either ran (or timed out / not accepted)
 * or rejected because the FIFO queue would exceed [GestureFlightQueue.maxWaiters].
 */
sealed class GestureAwaitOutcome {
    data class Done(val result: GestureResult) : GestureAwaitOutcome()
    data object Busy : GestureAwaitOutcome()
}

const val GESTURE_DEFAULT_TIMEOUT_MS = 3_000L
const val GESTURE_MAX_TIMEOUT_MS = 10_000L
/** Max waiters behind the single in-flight gesture (queue depth). */
const val GESTURE_MAX_QUEUE_DEPTH = 4

/**
 * Single-flight gesture lock with FIFO waiters.
 *
 * - At most one holder at a time.
 * - Waiters queue FIFO; if adding another waiter would make queue depth &gt; [maxWaiters],
 *   [tryEnter] returns [EnterResult.Busy] immediately.
 * - Time spent waiting in the queue counts against the caller's [timeoutMs] budget
 *   (remaining time is returned so the actual gesture latch uses what's left).
 *
 * Pure Kotlin — inject [clockMs] for deterministic tests. The queue does not run
 * gestures itself; [RivetAccessibilityService] pairs this with [GestureResultCallback].
 */
class GestureFlightQueue(
    private val maxWaiters: Int = GESTURE_MAX_QUEUE_DEPTH,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) {
    private val lock = ReentrantLock()
    private val notEmpty = lock.newCondition()
    private var held = false
    /** FIFO of waiter identities (tokens); size is queue depth. */
    private val waiters = ArrayDeque<Any>()

    sealed class EnterResult {
        /** Caller holds the flight slot; must [leave] when done. */
        data class Acquired(val remainingTimeoutMs: Long) : EnterResult()
        /** Queue full — do not block. */
        data object Busy : EnterResult()
        /** Timed out while waiting in queue (never held the slot). */
        data object TimedOut : EnterResult()
    }

    /**
     * Try to become the single in-flight holder.
     * @param timeoutMs total budget including queue wait (must be &gt; 0 to wait).
     */
    fun tryEnter(timeoutMs: Long): EnterResult {
        val start = clockMs()
        val budget = timeoutMs.coerceAtLeast(0L)
        lock.lock()
        try {
            // Fast path: free and nobody waiting.
            if (!held && waiters.isEmpty()) {
                held = true
                return EnterResult.Acquired(remainingTimeoutMs = remaining(start, budget))
            }
            // Zero budget (fire-and-forget): never park — bounce immediately rather than
            // transiently enqueue-and-remove.
            if (budget == 0L) {
                return EnterResult.Busy
            }
            // Would exceed queue depth → busy (do not wait).
            if (waiters.size >= maxWaiters) {
                return EnterResult.Busy
            }
            val token = Any()
            waiters.addLast(token)
            try {
                while (true) {
                    val rem = remaining(start, budget)
                    // Head of queue and free → promote.
                    if (!held && waiters.peekFirst() === token) {
                        waiters.removeFirst()
                        held = true
                        return EnterResult.Acquired(remainingTimeoutMs = rem)
                    }
                    if (rem <= 0L) {
                        waiters.remove(token)
                        // Wake next waiter in case we were head and someone else can run
                        // after a free slot appears without our hold.
                        notEmpty.signalAll()
                        return EnterResult.TimedOut
                    }
                    try {
                        notEmpty.await(rem, TimeUnit.MILLISECONDS)
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        waiters.remove(token)
                        notEmpty.signalAll()
                        return EnterResult.TimedOut
                    }
                }
            } catch (t: Throwable) {
                waiters.remove(token)
                notEmpty.signalAll()
                throw t
            }
        } finally {
            lock.unlock()
        }
    }

    /** Release the flight slot; wakes the FIFO head if any. */
    fun leave() {
        lock.withLock {
            held = false
            notEmpty.signalAll()
        }
    }

    /** Test/observability: current waiter count (not including holder). */
    fun waiterCount(): Int = lock.withLock { waiters.size }

    fun isHeld(): Boolean = lock.withLock { held }

    private fun remaining(start: Long, budget: Long): Long {
        val elapsed = (clockMs() - start).coerceAtLeast(0L)
        return (budget - elapsed).coerceAtLeast(0L)
    }
}

// ---------------------------------------------------------------------------
// Action request: wait + timeoutMs
// ---------------------------------------------------------------------------

data class ActionWaitParams(
    val wait: Boolean,
    val timeoutMs: Long,
)

/**
 * Parse `wait` (default true) and `timeoutMs` (default [GESTURE_DEFAULT_TIMEOUT_MS],
 * capped at [GESTURE_MAX_TIMEOUT_MS]) from an action JSON body.
 */
fun parseActionWaitParams(req: JSONObject): ActionWaitParams {
    val wait = if (req.has("wait")) req.optBoolean("wait", true) else true
    val raw = if (req.has("timeoutMs")) req.optLong("timeoutMs", GESTURE_DEFAULT_TIMEOUT_MS)
    else GESTURE_DEFAULT_TIMEOUT_MS
    val timeoutMs = raw.coerceIn(1L, GESTURE_MAX_TIMEOUT_MS)
    return ActionWaitParams(wait = wait, timeoutMs = timeoutMs)
}

// ---------------------------------------------------------------------------
// GestureResult → HTTP envelope
// ---------------------------------------------------------------------------

/**
 * Map a gesture outcome to the PR2 `/action` response.
 *
 * - [GestureAwaitOutcome.Busy] → HTTP 429, `error: busy`, `message: gesture_busy`
 * - wait=true: `ok` ≡ `completed`
 * - wait=false: `ok` ≡ `accepted`
 * - cancelled → 200, ok:false, `error: action_failed`
 * - timedOut → 200, ok:false, `error: timed_out`
 */
fun mapGestureOutcomeToHttp(
    type: String,
    wait: Boolean,
    outcome: GestureAwaitOutcome,
    executedAt: Long = System.currentTimeMillis(),
): HttpResponse {
    when (outcome) {
        is GestureAwaitOutcome.Busy -> {
            return errorResponse(
                code = 429,
                error = "busy",
                message = "gesture_busy",
            )
        }
        is GestureAwaitOutcome.Done -> {
            val r = outcome.result
            val ok = if (wait) r.completed else r.accepted
            val body = JSONObject()
                .put("ok", ok)
                .put("accepted", r.accepted)
                .put("completed", r.completed)
                .put("cancelled", r.cancelled)
                .put("timedOut", r.timedOut)
                .put("type", type)
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

/** Non-gesture action success/failure envelope: `{ok, type, executed_at}`. */
fun mapNonGestureActionToHttp(
    type: String,
    ok: Boolean,
    executedAt: Long = System.currentTimeMillis(),
): HttpResponse {
    val body = JSONObject()
        .put("ok", ok)
        .put("type", type)
        .put("executed_at", executedAt)
    if (!ok) {
        body.put("error", "action_failed")
    }
    return jsonResponse(200, body)
}

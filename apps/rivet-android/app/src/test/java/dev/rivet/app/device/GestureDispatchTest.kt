package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * JVM unit tests for gesture single-flight queue, action wait parse, and envelope mapping.
 */
class GestureDispatchTest {

    // ---- parseActionWaitParams ---------------------------------------------

    @Test
    fun `parseActionWaitParams defaults wait true and timeout 3000`() {
        val p = parseActionWaitParams(JSONObject())
        assertTrue(p.wait)
        assertEquals(GESTURE_DEFAULT_TIMEOUT_MS, p.timeoutMs)
    }

    @Test
    fun `parseActionWaitParams wait false`() {
        val p = parseActionWaitParams(JSONObject().put("wait", false))
        assertFalse(p.wait)
        assertEquals(GESTURE_DEFAULT_TIMEOUT_MS, p.timeoutMs)
    }

    @Test
    fun `parseActionWaitParams timeoutMs capped at 10000`() {
        val p = parseActionWaitParams(JSONObject().put("timeoutMs", 50_000L))
        assertEquals(GESTURE_MAX_TIMEOUT_MS, p.timeoutMs)
    }

    @Test
    fun `parseActionWaitParams timeoutMs floor at 1`() {
        val p = parseActionWaitParams(JSONObject().put("timeoutMs", 0L))
        assertEquals(1L, p.timeoutMs)
        val neg = parseActionWaitParams(JSONObject().put("timeoutMs", -100L))
        assertEquals(1L, neg.timeoutMs)
    }

    @Test
    fun `parseActionWaitParams custom timeout within cap`() {
        val p = parseActionWaitParams(
            JSONObject().put("wait", true).put("timeoutMs", 7500L),
        )
        assertTrue(p.wait)
        assertEquals(7500L, p.timeoutMs)
    }

    // ---- mapGestureOutcomeToHttp -------------------------------------------

    @Test
    fun `envelope wait true ok equals completed`() {
        val completed = GestureAwaitOutcome.Done(
            GestureResult(accepted = true, completed = true, cancelled = false, timedOut = false, durationMs = 40),
        )
        val res = mapGestureOutcomeToHttp("click", wait = true, completed, executedAt = 99L)
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertTrue(body.getBoolean("ok"))
        assertTrue(body.getBoolean("accepted"))
        assertTrue(body.getBoolean("completed"))
        assertEquals("click", body.getString("type"))
        assertEquals(40, body.getLong("durationMs"))
        assertEquals(99L, body.getLong("executed_at"))
        assertFalse(body.has("error"))
    }

    @Test
    fun `envelope wait true accepted but not completed is ok false`() {
        val r = GestureAwaitOutcome.Done(
            GestureResult(accepted = true, completed = false, cancelled = false, timedOut = false, durationMs = 10),
        )
        val body = JSONObject(mapGestureOutcomeToHttp("swipe", wait = true, r).body.toString(Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertTrue(body.getBoolean("accepted"))
        assertFalse(body.getBoolean("completed"))
        assertEquals("action_failed", body.getString("error"))
    }

    @Test
    fun `envelope wait false ok equals accepted`() {
        val r = GestureAwaitOutcome.Done(
            GestureResult(accepted = true, completed = false, cancelled = false, timedOut = false, durationMs = 0),
        )
        val body = JSONObject(mapGestureOutcomeToHttp("click", wait = false, r).body.toString(Charsets.UTF_8))
        assertTrue(body.getBoolean("ok"))
        assertTrue(body.getBoolean("accepted"))
        assertFalse(body.getBoolean("completed"))
    }

    @Test
    fun `envelope wait false not accepted is ok false`() {
        val r = GestureAwaitOutcome.Done(
            GestureResult(accepted = false, completed = false, cancelled = false, timedOut = false, durationMs = 0),
        )
        val body = JSONObject(mapGestureOutcomeToHttp("click", wait = false, r).body.toString(Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertEquals("action_failed", body.getString("error"))
    }

    @Test
    fun `envelope cancelled is 200 action_failed`() {
        val r = GestureAwaitOutcome.Done(
            GestureResult(accepted = true, completed = false, cancelled = true, timedOut = false, durationMs = 15),
        )
        val res = mapGestureOutcomeToHttp("click", wait = true, r)
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertTrue(body.getBoolean("cancelled"))
        assertEquals("action_failed", body.getString("error"))
    }

    @Test
    fun `envelope timedOut is 200 timed_out`() {
        val r = GestureAwaitOutcome.Done(
            GestureResult(accepted = true, completed = false, cancelled = false, timedOut = true, durationMs = 3000),
        )
        val res = mapGestureOutcomeToHttp("swipe", wait = true, r)
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertTrue(body.getBoolean("timedOut"))
        assertEquals("timed_out", body.getString("error"))
    }

    @Test
    fun `envelope busy is HTTP 429 not rate_limited`() {
        val res = mapGestureOutcomeToHttp("click", wait = true, GestureAwaitOutcome.Busy)
        assertEquals(429, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertEquals("busy", body.getString("error"))
        assertEquals("gesture_busy", body.getString("message"))
        assertEquals(429, body.getInt("code"))
        assertFalse(body.has("rate_limited") || body.optString("error") == "rate_limited")
    }

    @Test
    fun `non-gesture envelope has type`() {
        val res = mapNonGestureActionToHttp("text", ok = true, executedAt = 42L)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertTrue(body.getBoolean("ok"))
        assertEquals("text", body.getString("type"))
        assertEquals(42L, body.getLong("executed_at"))
        assertFalse(body.has("accepted"))
    }

    @Test
    fun `non-gesture failure has action_failed`() {
        val body = JSONObject(mapNonGestureActionToHttp("global", ok = false).body.toString(Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertEquals("action_failed", body.getString("error"))
        assertEquals("global", body.getString("type"))
    }

    // ---- GestureFlightQueue ------------------------------------------------

    @Test
    fun `tryEnter free path acquires immediately`() {
        val q = GestureFlightQueue(maxWaiters = 4)
        val r = q.tryEnter(3_000L)
        assertTrue(r is GestureFlightQueue.EnterResult.Acquired)
        assertTrue(q.isHeld())
        assertEquals(0, q.waiterCount())
        val acq = r as GestureFlightQueue.EnterResult.Acquired
        assertTrue(acq.remainingTimeoutMs in 1L..3_000L)
        q.leave()
        assertFalse(q.isHeld())
    }

    @Test
    fun `queue depth overflow returns busy without waiting`() {
        val q = GestureFlightQueue(maxWaiters = 4)
        val hold = CountDownLatch(1)
        val holderReady = CountDownLatch(1)

        val holder = thread(name = "gesture-holder") {
            val r = q.tryEnter(30_000L)
            assertTrue(r is GestureFlightQueue.EnterResult.Acquired)
            holderReady.countDown()
            hold.await(10, TimeUnit.SECONDS)
            q.leave()
        }

        assertTrue(holderReady.await(2, TimeUnit.SECONDS))

        val waitersParked = CountDownLatch(4)
        val waiters = (1..4).map { i ->
            thread(name = "waiter-$i") {
                // Block until holder releases; count as "parked" once tryEnter has added us.
                // Race-safe: spin on waiterCount from test thread instead.
                val r = q.tryEnter(30_000L)
                waitersParked.countDown() // counts down when tryEnter returns (after leave)
                assertTrue("waiter $i got $r", r is GestureFlightQueue.EnterResult.Acquired)
                q.leave()
            }
        }

        // Wait until all 4 are queued behind the holder.
        val deadline = System.currentTimeMillis() + 3_000L
        while (q.waiterCount() < 4 && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        assertEquals("expected 4 waiters behind holder", 4, q.waiterCount())

        // 5th concurrent request → busy immediately.
        val busy = q.tryEnter(5_000L)
        assertTrue(busy is GestureFlightQueue.EnterResult.Busy)

        hold.countDown()
        holder.join(5_000)
        waiters.forEach { it.join(5_000) }
        assertFalse(q.isHeld())
        assertEquals(0, q.waiterCount())
    }

    @Test
    fun `FIFO order of acquisition after holder leaves`() {
        val q = GestureFlightQueue(maxWaiters = 4)
        val hold = CountDownLatch(1)
        val holderReady = CountDownLatch(1)
        val order = mutableListOf<Int>()
        val orderLock = Any()

        thread(name = "holder") {
            assertTrue(q.tryEnter(30_000L) is GestureFlightQueue.EnterResult.Acquired)
            holderReady.countDown()
            hold.await(10, TimeUnit.SECONDS)
            q.leave()
        }
        assertTrue(holderReady.await(2, TimeUnit.SECONDS))

        // Start waiters in order 1,2,3 with a barrier so they all race into the queue
        // after registering intent; small staggered starts enforce FIFO enqueue order.
        val started = CyclicBarrier(3)
        val threads = (1..3).map { id ->
            thread(name = "fifo-$id") {
                started.await(2, TimeUnit.SECONDS)
                // Stagger by id so enqueue order is 1,2,3.
                Thread.sleep((id - 1) * 30L)
                val r = q.tryEnter(10_000L)
                assertTrue(r is GestureFlightQueue.EnterResult.Acquired)
                synchronized(orderLock) { order.add(id) }
                // Hold briefly so the next waiter cannot overtake before we record.
                Thread.sleep(20)
                q.leave()
            }
        }

        val deadline = System.currentTimeMillis() + 3_000L
        while (q.waiterCount() < 3 && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        assertEquals(3, q.waiterCount())

        hold.countDown()
        threads.forEach { it.join(5_000) }

        assertEquals(listOf(1, 2, 3), order)
    }

    @Test
    fun `queue wait consumes timeout budget`() {
        val q = GestureFlightQueue(maxWaiters = 4)
        val hold = CountDownLatch(1)
        val holderReady = CountDownLatch(1)

        thread {
            assertTrue(q.tryEnter(30_000L) is GestureFlightQueue.EnterResult.Acquired)
            holderReady.countDown()
            hold.await(10, TimeUnit.SECONDS)
            q.leave()
        }
        assertTrue(holderReady.await(2, TimeUnit.SECONDS))

        val result = AtomicReference<GestureFlightQueue.EnterResult?>(null)
        val budget = 500L
        val t = thread {
            result.set(q.tryEnter(budget))
            // If acquired, release so test can finish cleanly.
            if (result.get() is GestureFlightQueue.EnterResult.Acquired) {
                q.leave()
            }
        }

        // Keep holder longer than budget so waiter times out in queue.
        Thread.sleep(budget + 150L)
        hold.countDown()
        t.join(3_000)

        assertTrue(
            "expected TimedOut while waiting in queue, got ${result.get()}",
            result.get() is GestureFlightQueue.EnterResult.TimedOut,
        )
        // Waiter must not remain in the queue after timeout.
        assertEquals(0, q.waiterCount())
    }

    @Test
    fun `remaining timeout reduced after queue wait`() {
        val q = GestureFlightQueue(maxWaiters = 4)
        val releaseHolder = CountDownLatch(1)
        val holderReady = CountDownLatch(1)

        thread {
            assertTrue(q.tryEnter(30_000L) is GestureFlightQueue.EnterResult.Acquired)
            holderReady.countDown()
            // Stay held until the test has confirmed a waiter is queued, then
            // burn ~150ms of the waiter's budget before leave().
            releaseHolder.await(5, TimeUnit.SECONDS)
            Thread.sleep(150)
            q.leave()
        }
        assertTrue(holderReady.await(2, TimeUnit.SECONDS))

        val remaining = AtomicInteger(-1)
        val t = thread {
            val r = q.tryEnter(1_000L)
            assertTrue(r is GestureFlightQueue.EnterResult.Acquired)
            remaining.set((r as GestureFlightQueue.EnterResult.Acquired).remainingTimeoutMs.toInt())
            q.leave()
        }

        // Ensure waiter is queued, then release holder.
        val deadline = System.currentTimeMillis() + 2_000L
        while (q.waiterCount() < 1 && System.currentTimeMillis() < deadline) {
            Thread.sleep(5)
        }
        assertEquals(1, q.waiterCount())
        releaseHolder.countDown()

        t.join(3_000)
        assertTrue("remaining should be set", remaining.get() >= 0)
        // Budget 1000ms, queued ≥150ms → remaining well under 1000 and above 0.
        assertTrue(
            "remainingTimeoutMs=${remaining.get()} should be < 900 after queue wait",
            remaining.get() < 900,
        )
        assertTrue(remaining.get() > 0)
    }
}

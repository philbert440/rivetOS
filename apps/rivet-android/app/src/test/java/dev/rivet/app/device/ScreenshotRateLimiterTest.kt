package dev.rivet.app.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong

class ScreenshotRateLimiterTest {

    private fun clock(start: Long = 1_000_000L): Pair<AtomicLong, () -> Long> {
        val t = AtomicLong(start)
        return t to { t.get() }
    }

    @Test
    fun `allows up to 2 per second then rejects`() {
        val (t, clock) = clock()
        val lim = ScreenshotRateLimiter(clockMs = clock, perSecond = 2, perMinute = 30)

        val a = lim.tryAcquire()
        assertTrue(a.allowed)
        lim.releaseEncode()

        t.addAndGet(10)
        val b = lim.tryAcquire()
        assertTrue(b.allowed)
        lim.releaseEncode()

        t.addAndGet(10)
        val c = lim.tryAcquire()
        assertFalse(c.allowed)
        assertTrue(c.retryAfterMs > 0)

        // After 1s window slides, allow again
        t.addAndGet(c.retryAfterMs)
        val d = lim.tryAcquire()
        assertTrue(d.allowed)
        lim.releaseEncode()
    }

    @Test
    fun `enforces 30 per minute even if second window allows`() {
        val (t, clock) = clock()
        val lim = ScreenshotRateLimiter(clockMs = clock, perSecond = 100, perMinute = 30)

        repeat(30) {
            val r = lim.tryAcquire()
            assertTrue("acquire #$it", r.allowed)
            lim.releaseEncode()
            t.addAndGet(50) // stay well under per-second if it were tighter
        }
        val blocked = lim.tryAcquire()
        assertFalse(blocked.allowed)
        assertTrue(blocked.retryAfterMs > 0)

        t.addAndGet(blocked.retryAfterMs)
        val after = lim.tryAcquire()
        assertTrue(after.allowed)
        lim.releaseEncode()
    }

    @Test
    fun `concurrent encode slot rejects while held`() {
        val (_, clock) = clock()
        val lim = ScreenshotRateLimiter(clockMs = clock)

        val first = lim.tryAcquire()
        assertTrue(first.allowed)

        val second = lim.tryAcquire()
        assertFalse(second.allowed)
        assertEquals(250L, second.retryAfterMs)

        lim.releaseEncode()
        val third = lim.tryAcquire()
        assertTrue(third.allowed)
        lim.releaseEncode()
    }

    @Test
    fun `retryAfterSeconds rounds up`() {
        assertEquals(0, retryAfterSeconds(0))
        assertEquals(1, retryAfterSeconds(1))
        assertEquals(1, retryAfterSeconds(999))
        assertEquals(1, retryAfterSeconds(1000))
        assertEquals(2, retryAfterSeconds(1001))
        assertEquals(2, retryAfterSeconds(2000))
    }

    @Test
    fun `retry_after_ms matches window expiry for per-second`() {
        val (t, clock) = clock(5_000L)
        val lim = ScreenshotRateLimiter(clockMs = clock, perSecond = 2, perMinute = 30)

        assertTrue(lim.tryAcquire().allowed); lim.releaseEncode()
        t.set(5_100L)
        assertTrue(lim.tryAcquire().allowed); lim.releaseEncode()
        t.set(5_200L)
        val blocked = lim.tryAcquire()
        assertFalse(blocked.allowed)
        // oldest in 1s window is 5000; free at 6000 → retry 800ms from 5200
        assertEquals(800L, blocked.retryAfterMs)
        assertEquals(1, retryAfterSeconds(blocked.retryAfterMs))
    }
}

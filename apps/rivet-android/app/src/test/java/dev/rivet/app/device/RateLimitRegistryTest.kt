package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong

class RateLimitRegistryTest {

    private fun clock(start: Long = 1_000_000L): Pair<AtomicLong, () -> Long> {
        val t = AtomicLong(start)
        return t to { t.get() }
    }

    @Test
    fun `action allows 20 per second then rejects`() {
        val (t, clock) = clock()
        val reg = RateLimitRegistry(clockMs = clock, actionPerSecond = 20, uiPerSecond = 10)
        repeat(20) {
            assertTrue("acquire #$it", reg.tryAcquire("action").allowed)
            t.addAndGet(1)
        }
        val blocked = reg.tryAcquire("action")
        assertFalse(blocked.allowed)
        assertTrue(blocked.retryAfterMs > 0)

        t.addAndGet(blocked.retryAfterMs)
        assertTrue(reg.tryAcquire("action").allowed)
    }

    @Test
    fun `ui allows 10 per second then rejects`() {
        val (t, clock) = clock()
        val reg = RateLimitRegistry(clockMs = clock, actionPerSecond = 20, uiPerSecond = 10)
        repeat(10) {
            assertTrue(reg.tryAcquire("ui").allowed)
            t.addAndGet(1)
        }
        val blocked = reg.tryAcquire("ui")
        assertFalse(blocked.allowed)
        assertTrue(blocked.retryAfterMs > 0)
    }

    @Test
    fun `action and ui buckets are independent`() {
        val (t, clock) = clock()
        val reg = RateLimitRegistry(clockMs = clock, actionPerSecond = 2, uiPerSecond = 2)
        assertTrue(reg.tryAcquire("action").allowed)
        assertTrue(reg.tryAcquire("action").allowed)
        assertFalse(reg.tryAcquire("action").allowed)
        // ui still free
        assertTrue(reg.tryAcquire("ui").allowed)
        assertTrue(reg.tryAcquire("ui").allowed)
        assertFalse(reg.tryAcquire("ui").allowed)
        t.addAndGet(1) // silence unused warning if any
    }

    @Test
    fun `screenshot key is not limited by registry`() {
        val (_, clock) = clock()
        val reg = RateLimitRegistry(clockMs = clock, actionPerSecond = 1, uiPerSecond = 1)
        // Exhaust action
        assertTrue(reg.tryAcquire("action").allowed)
        assertFalse(reg.tryAcquire("action").allowed)
        // screenshot key always allowed here (dedicated ScreenshotRateLimiter elsewhere)
        repeat(50) {
            assertTrue(reg.tryAcquire("screenshot").allowed)
        }
    }

    @Test
    fun `unknown endpoint key allowed`() {
        val reg = RateLimitRegistry()
        assertTrue(reg.tryAcquire("notify").allowed)
        assertTrue(reg.tryAcquire("status").allowed)
    }

    @Test
    fun `SlidingWindowRateLimiter retryAfter matches window`() {
        val (t, clock) = clock(5_000L)
        val lim = SlidingWindowRateLimiter(perWindow = 2, windowMs = 1_000L, clockMs = clock)
        assertTrue(lim.tryAcquire().allowed)
        t.set(5_100L)
        assertTrue(lim.tryAcquire().allowed)
        t.set(5_200L)
        val blocked = lim.tryAcquire()
        assertFalse(blocked.allowed)
        // oldest at 5000 frees at 6000 → 800ms from 5200
        assertEquals(800L, blocked.retryAfterMs)
    }

    @Test
    fun `rateLimitedResponse shape`() {
        val res = rateLimitedResponse("action rate limit exceeded", 750L)
        assertEquals(429, res.code)
        val body = JSONObject(String(res.body, Charsets.UTF_8))
        assertEquals("rate_limited", body.getString("error"))
        assertEquals(750L, body.getLong("retry_after_ms"))
        assertTrue(res.headers.containsKey("Retry-After"))
        assertEquals("1", res.headers["Retry-After"]) // ceil 750ms → 1s
    }
}

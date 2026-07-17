package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * JVM unit tests for POST /wait pure helpers: condition eval, param parse/clamps,
 * concurrency limiter, and success/timeout envelopes.
 */
class WaitObserveTest {

    // ---- Condition evaluation ----------------------------------------------

    private fun snap(
        vararg labels: WaitNodeLabels,
        pkg: String? = "com.example.app",
    ) = WaitSnapshot(nodes = labels.toList(), currentPackage = pkg)

    private fun params(
        text: String? = null,
        packageEquals: String? = null,
        gone: String? = null,
        timeoutMs: Long = WAIT_DEFAULT_TIMEOUT_MS,
        intervalMs: Long = WAIT_DEFAULT_INTERVAL_MS,
    ) = WaitRequestParams(
        text = text,
        packageEquals = packageEquals,
        gone = gone,
        timeoutMs = timeoutMs,
        intervalMs = intervalMs,
    )

    @Test
    fun `text contains match on node text case-insensitive`() {
        val s = snap(WaitNodeLabels(text = "Tap Continue Here"))
        assertEquals("text", evaluateWaitCondition(s, params(text = "continue")))
    }

    @Test
    fun `text contains match on contentDescription`() {
        val s = snap(WaitNodeLabels(text = "", contentDescription = "Submit form"))
        assertEquals("text", evaluateWaitCondition(s, params(text = "submit")))
    }

    @Test
    fun `text non-match returns null`() {
        val s = snap(WaitNodeLabels(text = "Hello"))
        assertNull(evaluateWaitCondition(s, params(text = "Continue")))
    }

    @Test
    fun `text ignores non-visible-only list — empty list no match`() {
        val s = snap(pkg = "com.x")
        assertNull(evaluateWaitCondition(s, params(text = "x")))
    }

    @Test
    fun `package equals match`() {
        val s = snap(pkg = "com.android.settings")
        assertEquals(
            "package",
            evaluateWaitCondition(s, params(packageEquals = "com.android.settings")),
        )
    }

    @Test
    fun `package non-match`() {
        val s = snap(pkg = "com.other")
        assertNull(evaluateWaitCondition(s, params(packageEquals = "com.android.settings")))
    }

    @Test
    fun `package null current does not match`() {
        val s = snap(pkg = null)
        assertNull(evaluateWaitCondition(s, params(packageEquals = "com.x")))
    }

    @Test
    fun `gone matches when no node contains text`() {
        val s = snap(WaitNodeLabels(text = "Ready"))
        assertEquals("gone", evaluateWaitCondition(s, params(gone = "Loading")))
    }

    @Test
    fun `gone does not match while text still visible`() {
        val s = snap(WaitNodeLabels(text = "Still Loading…"))
        assertNull(evaluateWaitCondition(s, params(gone = "loading")))
    }

    @Test
    fun `gone matches empty node list`() {
        val s = snap(pkg = "com.x")
        assertEquals("gone", evaluateWaitCondition(s, params(gone = "Spinner")))
    }

    @Test
    fun `priority text over package when both hold`() {
        val s = snap(WaitNodeLabels(text = "OK"), pkg = "com.x")
        assertEquals(
            "text",
            evaluateWaitCondition(
                s,
                params(text = "ok", packageEquals = "com.x"),
            ),
        )
    }

    @Test
    fun `priority package over gone when both hold`() {
        val s = snap(WaitNodeLabels(text = "Hello"), pkg = "com.x")
        assertEquals(
            "package",
            evaluateWaitCondition(
                s,
                params(packageEquals = "com.x", gone = "Loading"),
            ),
        )
    }

    @Test
    fun `nodeLabelsContain empty query is false`() {
        assertFalse(nodeLabelsContain(WaitNodeLabels(text = "a"), ""))
    }

    // ---- Param parsing + clamps --------------------------------------------

    @Test
    fun `parseWaitBody defaults timeout and interval`() {
        val r = parseWaitBody(JSONObject().put("text", "Continue")) as ParseWaitResult.Ok
        assertEquals("Continue", r.params.text)
        assertNull(r.params.packageEquals)
        assertNull(r.params.gone)
        assertEquals(WAIT_DEFAULT_TIMEOUT_MS, r.params.timeoutMs)
        assertEquals(WAIT_DEFAULT_INTERVAL_MS, r.params.intervalMs)
    }

    @Test
    fun `parseWaitBody accepts package and gone`() {
        val r = parseWaitBody(
            JSONObject()
                .put("package", "com.x")
                .put("gone", "Loading"),
        ) as ParseWaitResult.Ok
        assertEquals("com.x", r.params.packageEquals)
        assertEquals("Loading", r.params.gone)
    }

    @Test
    fun `parseWaitBody requires at least one condition`() {
        val r = parseWaitBody(JSONObject()) as ParseWaitResult.BadRequest
        assertTrue(r.message.contains("text|package|gone"))
    }

    @Test
    fun `parseWaitBody rejects blank-only conditions`() {
        val r = parseWaitBody(
            JSONObject().put("text", "   ").put("package", ""),
        ) as ParseWaitResult.BadRequest
        assertTrue(r.message.contains("required"))
    }

    @Test
    fun `parseWaitBody clamps timeoutMs to max 30000`() {
        val r = parseWaitBody(
            JSONObject().put("text", "x").put("timeoutMs", 99_000L),
        ) as ParseWaitResult.Ok
        assertEquals(WAIT_MAX_TIMEOUT_MS, r.params.timeoutMs)
    }

    @Test
    fun `parseWaitBody clamps timeoutMs floor at 1`() {
        val r = parseWaitBody(
            JSONObject().put("text", "x").put("timeoutMs", 0L),
        ) as ParseWaitResult.Ok
        assertEquals(1L, r.params.timeoutMs)
        val neg = parseWaitBody(
            JSONObject().put("text", "x").put("timeoutMs", -50L),
        ) as ParseWaitResult.Ok
        assertEquals(1L, neg.params.timeoutMs)
    }

    @Test
    fun `parseWaitBody clamps intervalMs min 50`() {
        val r = parseWaitBody(
            JSONObject().put("text", "x").put("intervalMs", 10L),
        ) as ParseWaitResult.Ok
        assertEquals(WAIT_MIN_INTERVAL_MS, r.params.intervalMs)
    }

    @Test
    fun `parseWaitBody custom timeout and interval within range`() {
        val r = parseWaitBody(
            JSONObject()
                .put("text", "Go")
                .put("timeoutMs", 12_000L)
                .put("intervalMs", 100L),
        ) as ParseWaitResult.Ok
        assertEquals(12_000L, r.params.timeoutMs)
        assertEquals(100L, r.params.intervalMs)
    }

    // ---- Concurrency limiter -----------------------------------------------

    @Test
    fun `WaitConcurrencyLimiter allows 5 and rejects 6th`() {
        val lim = WaitConcurrencyLimiter(maxConcurrent = 5, retryAfterMs = 500L)
        val held = mutableListOf<Boolean>()
        repeat(5) {
            val r = lim.tryAcquire()
            assertTrue("slot $it should be allowed", r.allowed)
            held.add(true)
        }
        val sixth = lim.tryAcquire()
        assertFalse(sixth.allowed)
        assertEquals(500L, sixth.retryAfterMs)
        assertEquals(0, lim.availablePermits())

        lim.release()
        val afterRelease = lim.tryAcquire()
        assertTrue(afterRelease.allowed)
        // 5 still held after re-acquire; drain all
        repeat(5) { lim.release() }
        assertEquals(5, lim.availablePermits())
    }

    @Test
    fun `WaitConcurrencyLimiter concurrent threads never exceed max`() {
        val max = 5
        val lim = WaitConcurrencyLimiter(maxConcurrent = max)
        val inFlight = AtomicInteger(0)
        val peak = AtomicInteger(0)
        val rejected = AtomicInteger(0)
        val start = CountDownLatch(1)
        val done = CountDownLatch(20)
        val threads = (1..20).map {
            thread(name = "wait-lim-$it") {
                start.await(2, TimeUnit.SECONDS)
                val r = lim.tryAcquire()
                if (!r.allowed) {
                    rejected.incrementAndGet()
                    done.countDown()
                    return@thread
                }
                val now = inFlight.incrementAndGet()
                peak.updateAndGet { p -> maxOf(p, now) }
                Thread.sleep(30)
                inFlight.decrementAndGet()
                lim.release()
                done.countDown()
            }
        }
        start.countDown()
        assertTrue(done.await(5, TimeUnit.SECONDS))
        threads.forEach { it.join(2_000) }
        assertTrue("peak was ${peak.get()}", peak.get() <= max)
        assertTrue("expected some rejections, got ${rejected.get()}", rejected.get() > 0)
        assertEquals(max, lim.availablePermits())
    }

    // ---- Response envelopes ------------------------------------------------

    @Test
    fun `waitSuccessResponse shape`() {
        val res = waitSuccessResponse("text", waitedMs = 420L, currentPackage = "com.x")
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertTrue(body.getBoolean("ok"))
        assertEquals("text", body.getString("matched"))
        assertEquals(420L, body.getLong("waitedMs"))
        assertEquals("com.x", body.getString("current_package"))
    }

    @Test
    fun `waitTimeoutResponse is 200 ok false timed_out`() {
        val res = waitTimeoutResponse(waitedMs = 8000L)
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertEquals("timed_out", body.getString("error"))
        assertEquals(8000L, body.getLong("waitedMs"))
        assertEquals(200, body.getInt("code"))
        assertNotNull(body.optString("message"))
    }
}

package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Mode matrix, screenshot param parsing, and gate-order tests for PR1b pure helpers.
 */
class ControlPolicyTest {

    // ---- Mode gate matrix --------------------------------------------------

    private val endpoints = ControlEndpoint.entries
    private val modes = ControlMode.entries

    @Test
    fun `mode matrix matches plan T1_1b for all endpoints x modes`() {
        // Expected allowed set from plan + /exec like action + /mode always + /status/notify always
        fun expected(ep: ControlEndpoint, mode: ControlMode): Boolean = when (ep) {
            ControlEndpoint.STATUS, ControlEndpoint.NOTIFY, ControlEndpoint.MODE -> true
            ControlEndpoint.UI, ControlEndpoint.SCREENSHOT -> mode != ControlMode.PARKED
            ControlEndpoint.ACTION, ControlEndpoint.EXEC, ControlEndpoint.WAIT -> mode == ControlMode.FULL
        }

        for (mode in modes) {
            for (ep in endpoints) {
                assertEquals(
                    "mode=${mode.wire} endpoint=${ep.name}",
                    expected(ep, mode),
                    isEndpointAllowed(ep, mode),
                )
            }
        }
    }

    @Test
    fun `parked blocks ui screenshot action exec wait`() {
        val m = ControlMode.PARKED
        assertFalse(isEndpointAllowed(ControlEndpoint.UI, m))
        assertFalse(isEndpointAllowed(ControlEndpoint.SCREENSHOT, m))
        assertFalse(isEndpointAllowed(ControlEndpoint.ACTION, m))
        assertFalse(isEndpointAllowed(ControlEndpoint.EXEC, m))
        assertFalse(isEndpointAllowed(ControlEndpoint.WAIT, m))
        assertTrue(isEndpointAllowed(ControlEndpoint.STATUS, m))
        assertTrue(isEndpointAllowed(ControlEndpoint.NOTIFY, m))
        assertTrue(isEndpointAllowed(ControlEndpoint.MODE, m))
    }

    @Test
    fun `eyes allows see blocks act`() {
        val m = ControlMode.EYES
        assertTrue(isEndpointAllowed(ControlEndpoint.UI, m))
        assertTrue(isEndpointAllowed(ControlEndpoint.SCREENSHOT, m))
        assertFalse(isEndpointAllowed(ControlEndpoint.ACTION, m))
        assertFalse(isEndpointAllowed(ControlEndpoint.EXEC, m))
        assertTrue(isEndpointAllowed(ControlEndpoint.NOTIFY, m))
    }

    @Test
    fun `full allows everything`() {
        for (ep in endpoints) {
            assertTrue(isEndpointAllowed(ep, ControlMode.FULL))
        }
    }

    @Test
    fun `ControlMode parse accepts wire names`() {
        assertEquals(ControlMode.FULL, ControlMode.parse("full"))
        assertEquals(ControlMode.EYES, ControlMode.parse("EYES"))
        assertEquals(ControlMode.PARKED, ControlMode.parse("parked"))
        assertEquals(null, ControlMode.parse("turbo"))
        assertEquals(null, ControlMode.parse(null))
    }

    // ---- Screenshot query parsing ------------------------------------------

    @Test
    fun `parseScreenshotQuery defaults`() {
        val r = parseScreenshotQuery(emptyMap()) as ParseScreenshotResult.Ok
        assertEquals(0.4f, r.params.scale, 0.0001f)
        assertEquals(70, r.params.quality)
        assertEquals("jpeg", r.params.format)
        assertEquals(0, r.params.displayId)
        assertEquals("file", r.params.dest)
        assertFalse(r.params.includeBase64)
    }

    @Test
    fun `parseScreenshotQuery clamps scale and quality`() {
        val r = parseScreenshotQuery(
            mapOf("scale" to "2.5", "quality" to "0", "dest" to "json"),
        ) as ParseScreenshotResult.Ok
        assertEquals(1.0f, r.params.scale, 0.0001f)
        assertEquals(1, r.params.quality)
        assertEquals("json", r.params.dest)
    }

    @Test
    fun `parseScreenshotQuery clamps scale low and quality high`() {
        val r = parseScreenshotQuery(
            mapOf("scale" to "0.01", "quality" to "999"),
        ) as ParseScreenshotResult.Ok
        assertEquals(0.1f, r.params.scale, 0.0001f)
        assertEquals(100, r.params.quality)
    }

    @Test
    fun `parseScreenshotQuery rejects bad format`() {
        val r = parseScreenshotQuery(mapOf("format" to "png")) as ParseScreenshotResult.BadRequest
        assertTrue(r.message.contains("jpeg"))
    }

    @Test
    fun `parseScreenshotQuery rejects bad dest`() {
        val r = parseScreenshotQuery(mapOf("dest" to "s3")) as ParseScreenshotResult.BadRequest
        assertTrue(r.message.contains("dest"))
    }

    @Test
    fun `parseScreenshotQuery include_base64 and display`() {
        val r = parseScreenshotQuery(
            mapOf("include_base64" to "1", "display" to "2", "dest" to "file"),
        ) as ParseScreenshotResult.Ok
        assertTrue(r.params.includeBase64)
        assertEquals(2, r.params.displayId)
    }

    // ---- Gate order: mode / rate before capture ----------------------------

    @Test
    fun `parked does not invoke capture lambda`() {
        val called = AtomicBoolean(false)
        val lim = ScreenshotRateLimiter(clockMs = { 1_000L })
        val res = runScreenshotRoute(
            mode = ControlMode.PARKED,
            query = emptyMap(),
            limiter = lim,
            capture = {
                called.set(true)
                ScreenshotOutcome.Success(byteArrayOf(1), 1, 1, 0.4f)
            },
        )
        assertFalse("capture must not run when parked", called.get())
        assertEquals(403, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("forbidden_mode", body.getString("error"))
    }

    @Test
    fun `rate limited does not invoke capture lambda`() {
        val t = AtomicLong(1_000L)
        val lim = ScreenshotRateLimiter(clockMs = { t.get() }, perSecond = 1, perMinute = 30)
        // consume the only slot
        assertTrue(lim.tryAcquire().allowed)
        lim.releaseEncode()

        val called = AtomicBoolean(false)
        val res = runScreenshotRoute(
            mode = ControlMode.FULL,
            query = emptyMap(),
            limiter = lim,
            capture = {
                called.set(true)
                ScreenshotOutcome.Success(byteArrayOf(1), 1, 1, 0.4f)
            },
        )
        assertFalse("capture must not run when rate limited", called.get())
        assertEquals(429, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("rate_limited", body.getString("error"))
        assertTrue(body.has("retry_after_ms"))
        assertTrue(res.headers.containsKey("Retry-After"))
    }

    @Test
    fun `full mode invokes capture once when allowed`() {
        val calls = AtomicInteger(0)
        val lim = ScreenshotRateLimiter(clockMs = { 1_000L })
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x00, 0x01)
        val res = runScreenshotRoute(
            mode = ControlMode.FULL,
            query = mapOf("dest" to "json"),
            limiter = lim,
            capture = {
                calls.incrementAndGet()
                ScreenshotOutcome.Success(jpeg, 10, 20, 0.4f)
            },
        )
        assertEquals(1, calls.get())
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertTrue(body.getBoolean("ok"))
        assertEquals(10, body.getInt("width"))
        assertTrue(body.has("base64"))
        assertFalse(body.has("path"))
    }

    @Test
    fun `dest=file writes via callback and returns guest path`() {
        val written = AtomicBoolean(false)
        val lim = ScreenshotRateLimiter(clockMs = { 1_000L })
        val jpeg = byteArrayOf(1, 2, 3, 4)
        val res = runScreenshotRoute(
            mode = ControlMode.EYES,
            query = mapOf("dest" to "file"),
            limiter = lim,
            capture = {
                ScreenshotOutcome.Success(jpeg, 8, 16, 0.5f)
            },
            writeFile = {
                written.set(true)
                true
            },
        )
        assertTrue(written.get())
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals(SCREENSHOT_GUEST_PATH, body.getString("path"))
        assertFalse(body.has("base64"))
    }

    @Test
    fun `parked does not write file`() {
        val written = AtomicBoolean(false)
        val lim = ScreenshotRateLimiter(clockMs = { 1_000L })
        runScreenshotRoute(
            mode = ControlMode.PARKED,
            query = mapOf("dest" to "file"),
            limiter = lim,
            capture = { ScreenshotOutcome.Success(byteArrayOf(1), 1, 1, 1f) },
            writeFile = { written.set(true); true },
        )
        assertFalse(written.get())
    }

    @Test
    fun `secure_window is HTTP 200 ok false`() {
        val lim = ScreenshotRateLimiter(clockMs = { 1_000L })
        val res = runScreenshotRoute(
            mode = ControlMode.FULL,
            query = emptyMap(),
            limiter = lim,
            capture = {
                ScreenshotOutcome.Error("secure_window", "secure window blocks screenshot")
            },
        )
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertEquals("secure_window", body.getString("error"))
    }

    @Test
    fun `unsupported is HTTP 501`() {
        val lim = ScreenshotRateLimiter(clockMs = { 1_000L })
        val res = runScreenshotRoute(
            mode = ControlMode.FULL,
            query = emptyMap(),
            limiter = lim,
            capture = { ScreenshotOutcome.Unsupported },
        )
        assertEquals(501, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("unsupported", body.getString("error"))
    }

    @Test
    fun `bad format never captures`() {
        val called = AtomicBoolean(false)
        val lim = ScreenshotRateLimiter(clockMs = { 1_000L })
        val res = runScreenshotRoute(
            mode = ControlMode.FULL,
            query = mapOf("format" to "webp"),
            limiter = lim,
            capture = {
                called.set(true)
                ScreenshotOutcome.Success(byteArrayOf(1), 1, 1, 1f)
            },
        )
        assertFalse(called.get())
        assertEquals(400, res.code)
    }

    @Test
    fun `mapTakeScreenshotErrorCode stable strings`() {
        assertEquals("internal_error", mapTakeScreenshotErrorCode(1).first)
        assertEquals("no_accessibility_access", mapTakeScreenshotErrorCode(2).first)
        assertEquals("interval_interval", mapTakeScreenshotErrorCode(3).first)
        assertEquals("invalid_display", mapTakeScreenshotErrorCode(4).first)
        assertEquals("secure_window", mapTakeScreenshotErrorCode(6).first)
    }

    @Test
    fun `buildCapabilitiesJson schema 1 with gesture_wait`() {
        val cap = buildCapabilitiesJson(screenshotSupported = true, execEnabled = false)
        assertEquals(1, cap.getInt("schema"))
        assertTrue(cap.getJSONObject("screenshot").getBoolean("supported"))
        assertEquals(30, cap.getJSONObject("screenshot").getInt("minApi"))
        assertTrue(cap.getBoolean("gesture_wait"))
        val formats = cap.getJSONObject("ui").getJSONArray("formats")
        assertEquals(3, formats.length())
        assertEquals("flat", formats.getString(0))
        assertEquals("tree", formats.getString(1))
        assertEquals("compact", formats.getString(2))
        // PR3a+PR3b: node_id true, filters true
        assertTrue(cap.getJSONObject("ui").getBoolean("node_id"))
        assertTrue(cap.getJSONObject("ui").getBoolean("filters"))
        assertFalse(cap.getBoolean("wait"))
        assertFalse(cap.getBoolean("exec"))
        assertEquals(3, cap.getJSONArray("modes").length())
    }

    @Test
    fun `dest=raw returns image jpeg with dimension headers`() {
        val lim = ScreenshotRateLimiter(clockMs = { 1_000L })
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte())
        val res = runScreenshotRoute(
            mode = ControlMode.FULL,
            query = mapOf("dest" to "raw"),
            limiter = lim,
            capture = { ScreenshotOutcome.Success(jpeg, 100, 200, 0.4f) },
        )
        assertEquals(200, res.code)
        assertEquals("image/jpeg", res.contentType)
        assertEquals("100", res.headers["X-Rivet-Width"])
        assertEquals("200", res.headers["X-Rivet-Height"])
        assertEquals("0.4", res.headers["X-Rivet-Scale"])
        assertTrue(res.body.contentEquals(jpeg))
    }
}

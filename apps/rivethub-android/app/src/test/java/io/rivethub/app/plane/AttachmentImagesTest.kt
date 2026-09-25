package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentImagesTest {
    /** The sampled size must respect both hard bounds (sides rounded up, like the rule). */
    private fun assertBounded(w: Int, h: Int, s: Int) {
        val sw = (w.toLong() + s - 1) / s
        val sh = (h.toLong() + s - 1) / s
        assertTrue("pixels ${sw * sh}", sw * sh <= MAX_DECODE_PIXELS)
        assertTrue("side ${maxOf(sw, sh)}", maxOf(sw, sh) <= MAX_DECODE_DIM)
    }

    @Test
    fun `panoramic source is sampled until the long side fits`() {
        // Old rule (both sides above target) kept 1 here: a ~120 MB decode.
        assertEquals(8, sampleSizeFor(30_000, 1_000, 2_048))
        assertBounded(30_000, 1_000, 8)
        assertEquals(8, sampleSizeFor(30_000, 1_000, 216))
    }

    @Test
    fun `tall source is sampled until the long side fits`() {
        assertEquals(8, sampleSizeFor(1_000, 30_000, 2_048))
        assertBounded(1_000, 30_000, 8)
    }

    @Test
    fun `square oversized source obeys the view rule and the pixel cap`() {
        // Thumbnail: the view rule alone (250px ≥ 216px short side).
        assertEquals(64, sampleSizeFor(16_000, 16_000, 216))
        // Full-screen target: the view rule would stop at 4 (4000², 16 MP); the pixel cap pushes to 8.
        assertEquals(8, sampleSizeFor(16_000, 16_000, 2_048))
        assertBounded(16_000, 16_000, 8)
    }

    @Test
    fun `full-screen target of a phone photo is capped by pixels`() {
        assertEquals(2, sampleSizeFor(4_000, 3_000, 2_048))
        assertBounded(4_000, 3_000, 2)
        assertEquals(1, sampleSizeFor(1_080, 2_400, 2_048))
    }

    @Test
    fun `exact boundaries are inclusive`() {
        assertEquals(1, sampleSizeFor(4_096, 1_024, 4_096))
        assertEquals(2, sampleSizeFor(4_097, 1_024, 4_096))
        assertEquals(1, sampleSizeFor(2_048, 2_048, 4_096))
        assertEquals(2, sampleSizeFor(2_049, 2_048, 4_096))
        assertEquals(1, sampleSizeFor(1, 1, 216))
    }

    @Test
    fun `overflow-sized and absurd bounds are refused`() {
        // 46341² overflows Int; the Long check refuses it (over MAX_SOURCE_PIXELS).
        assertNull(sampleSizeFor(46_341, 46_341, 216))
        assertNull(sampleSizeFor(Int.MAX_VALUE, 2, 216))
        assertNull(sampleSizeFor(MAX_SOURCE_DIM + 1, 10, 216))
        assertNull(sampleSizeFor(0, 100, 216))
        assertNull(sampleSizeFor(100, -1, 216))
        assertNull(sampleSizeFor(100, 100, 216, maxPixels = 0))
        assertNull(sampleSizeFor(100, 100, 216, maxDim = 0))
        // The largest accepted source still samples into bounds.
        assertEquals(8, sampleSizeFor(16_384, 16_384, 4_096))
        assertBounded(MAX_SOURCE_DIM, 4_096, sampleSizeFor(MAX_SOURCE_DIM, 4_096, 216)!!)
    }

    @Test
    fun `a non-positive target is treated as one pixel, still bounded`() {
        val s = sampleSizeFor(8_000, 6_000, 0)!!
        assertBounded(8_000, 6_000, s)
    }

    @Test
    fun `identical paths on two nodes get different cache keys`() {
        val a = imageSourceNamespace("https://node-a.example:8443", 3)
        val b = imageSourceNamespace("https://node-b.example:8443", 3)
        assertNotEquals(imageCacheKey(a, 216, "/api/previews/image.png"), imageCacheKey(b, 216, "/api/previews/image.png"))
        assertEquals(imageCacheKey(a, 216, "/api/x.png"), imageCacheKey(a, 216, "/api/x.png"))
        assertNotEquals(imageCacheKey(a, 216, "/api/x.png"), imageCacheKey(a, 2048, "/api/x.png"))
    }

    @Test
    fun `namespace is the node origin plus identity generation`() {
        assertEquals(
            imageSourceNamespace("https://Node-A.example:8443/", 1),
            imageSourceNamespace("https://node-a.example:8443", 1),
        )
        assertNotEquals(imageSourceNamespace("https://a.example:8443", 1), imageSourceNamespace("https://a.example:9443", 1))
        assertNotEquals(imageSourceNamespace("https://a.example", 1), imageSourceNamespace("https://a.example", 2))
    }

    @Test
    fun `cache keys cannot collide across the separator`() {
        assertNotEquals(imageCacheKey("a|1", 2, "x"), imageCacheKey("a", 1, "2|x"))
    }
}

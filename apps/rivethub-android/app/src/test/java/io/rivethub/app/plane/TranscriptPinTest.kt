package io.rivethub.app.plane

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** transcript.tsx:385-480 port — the pin rules that drive follow-scroll. */
class TranscriptPinTest {
    @Test
    fun `first non-empty load pins and scrolls to the end unconditionally`() {
        val pin = TranscriptPin()
        assertTrue(pin.pinned)
        assertTrue(pin.onContent(12))
        assertTrue(pin.pinned)
    }

    @Test
    fun `scrolling up past the threshold unpins — the threshold itself is not near`() {
        val pin = TranscriptPin()
        pin.onScroll(TRANSCRIPT_NEAR_BOTTOM_DP + 1f)
        assertFalse(pin.pinned)
        pin.onScroll(TRANSCRIPT_NEAR_BOTTOM_DP - 1f)
        assertTrue(pin.pinned)
        // web: distance < NEAR_BOTTOM_PX — exactly 120dp does not count
        pin.onScroll(TRANSCRIPT_NEAR_BOTTOM_DP)
        assertFalse(pin.pinned)
    }

    @Test
    fun `append while unpinned holds position — no follow`() {
        val pin = TranscriptPin()
        assertTrue(pin.onContent(5))
        pin.onScroll(400f)
        assertFalse(pin.pinned)
        assertFalse(pin.onContent(6))
        assertFalse(pin.onContent(7))
        assertFalse(pin.pinned)
    }

    @Test
    fun `append while pinned follows`() {
        val pin = TranscriptPin()
        assertTrue(pin.onContent(5))
        pin.onScroll(0f)
        assertTrue(pin.onContent(6))
        assertTrue(pin.pinned)
    }

    @Test
    fun `jump re-pins and the next append follows again`() {
        val pin = TranscriptPin()
        assertTrue(pin.onContent(5))
        pin.onScroll(400f)
        assertFalse(pin.pinned)
        pin.jump()
        assertTrue(pin.pinned)
        assertTrue(pin.onContent(9))
    }

    @Test
    fun `empty content never scrolls and does not consume the first load`() {
        val pin = TranscriptPin()
        assertFalse(pin.onContent(0))
        // the first non-empty load still jumps to the end afterwards
        assertTrue(pin.onContent(3))
    }
}

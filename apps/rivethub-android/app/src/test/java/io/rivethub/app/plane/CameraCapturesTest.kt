package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraCapturesTest {
    private val now = 10L * CAPTURE_KEEP_MS

    @Test
    fun `a held capture is kept however old and an abandoned one is swept`() {
        val reg = CaptureRegistry()
        reg.hold("photo-live.jpg")
        val files = listOf(
            CaptureFile("photo-live.jpg", modifiedMs = 0L),
            CaptureFile("photo-abandoned.jpg", modifiedMs = 0L),
        )
        assertEquals(listOf("photo-abandoned.jpg"), capturesToSweep(files, reg.held(), now))
    }

    @Test
    fun `young captures stay and only past the cutoff are swept`() {
        val files = listOf(
            CaptureFile("fresh.jpg", modifiedMs = now - 1_000L),
            CaptureFile("edge.jpg", modifiedMs = now - CAPTURE_KEEP_MS),
            CaptureFile("stale.jpg", modifiedMs = now - CAPTURE_KEEP_MS - 1L),
        )
        assertEquals(listOf("stale.jpg"), capturesToSweep(files, emptySet(), now))
        assertTrue(capturesToSweep(emptyList(), emptySet(), now).isEmpty())
    }

    @Test
    fun `hold spans capture through upload and release frees it`() {
        val reg = CaptureRegistry()
        reg.hold("photo-1.jpg") // camera launched
        reg.hold("photo-1.jpg") // result back, upload started (idempotent)
        assertTrue(reg.isHeld("photo-1.jpg"))
        val old = listOf(CaptureFile("photo-1.jpg", modifiedMs = 0L))
        assertTrue(capturesToSweep(old, reg.held(), now).isEmpty())
        reg.release("photo-1.jpg") // upload finished
        assertFalse(reg.isHeld("photo-1.jpg"))
        assertEquals(listOf("photo-1.jpg"), capturesToSweep(old, reg.held(), now))
    }

    @Test
    fun `blank names are never held and releasing an unknown name is harmless`() {
        val reg = CaptureRegistry()
        reg.hold(" ")
        reg.hold("")
        reg.release("never-held.jpg")
        assertTrue(reg.held().isEmpty())
    }

    @Test
    fun `held snapshot does not track later changes`() {
        val reg = CaptureRegistry()
        reg.hold("a.jpg")
        val snap = reg.held()
        reg.hold("b.jpg")
        reg.release("a.jpg")
        assertEquals(setOf("a.jpg"), snap)
        assertEquals(setOf("b.jpg"), reg.held())
    }
}

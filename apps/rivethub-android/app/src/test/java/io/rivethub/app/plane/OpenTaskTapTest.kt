package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenTaskTapTest {
    @Test fun `fresh tap opens its task`() {
        val tap = openTaskFromIntent("task-1", "1000", consumedNonce = null)
        assertEquals(OpenTaskTap("task-1", openTaskMarker("task-1", "1000")), tap)
    }

    @Test fun `no or blank extra is nothing to open`() {
        assertNull(openTaskFromIntent(null, "1000", consumedNonce = null))
        assertNull(openTaskFromIntent("  ", "1000", consumedNonce = null))
    }

    @Test fun `consumed tap is a no-op and so is recreation re-reading it`() {
        val tap = openTaskFromIntent("task-1", "1000", consumedNonce = null)!!
        // After App() consumed it, the same intent read again (recreation,
        // process-death restore with extras intact) does not re-fire.
        assertNull(openTaskFromIntent("task-1", "1000", consumedNonce = tap.marker))
        val saved = rememberConsumedTap(emptyList(), tap.marker)
        assertNull(openTaskFromIntent("task-1", "1000", consumed = saved))
    }

    @Test fun `a fresh tap for the same task with a new nonce still opens`() {
        val first = openTaskFromIntent("task-1", "1000", consumedNonce = null)!!
        val again = openTaskFromIntent("task-1", "2000", consumedNonce = first.marker)
        assertEquals("task-1", again?.taskId)
    }

    @Test fun `an older launch intent stays consumed after a newer tap`() {
        val launch = openTaskFromIntent("task-1", "1000", consumedNonce = null)!!
        val newer = openTaskFromIntent("task-2", "2000", consumedNonce = launch.marker)!!
        val saved = rememberConsumedTap(rememberConsumedTap(emptyList(), launch.marker), newer.marker)
        assertNull(openTaskFromIntent("task-1", "1000", consumed = saved))
        assertNull(openTaskFromIntent("task-2", "2000", consumed = saved))
    }

    @Test fun `consumed markers are deduped and capped keeping the newest`() {
        var saved = emptyList<String>()
        for (i in 0 until CONSUMED_TAPS_MAX + 3) saved = rememberConsumedTap(saved, "m$i")
        assertEquals(CONSUMED_TAPS_MAX, saved.size)
        assertEquals("m${CONSUMED_TAPS_MAX + 2}", saved.last())
        assertEquals("m3", saved.first())
        val again = rememberConsumedTap(saved, "m3")
        assertEquals(CONSUMED_TAPS_MAX, again.size)
        assertEquals("m3", again.last())
    }

    @Test fun `the launch tap stays consumed after more than CONSUMED_TAPS_MAX later taps and a restore`() {
        // Cold start from notification A (read in onCreate), consumed.
        val launch = openTaskFromIntent("task-a", "1000", ConsumedTaps(), fromLaunch = true)!!
        assertTrue(launch.fromLaunch)
        var saved = rememberConsumedTap(ConsumedTaps(), launch)
        // Then more distinct onNewIntent taps than the recent list holds.
        for (i in 0 until CONSUMED_TAPS_MAX + 3) {
            val tap = openTaskFromIntent("task-$i", "${2000 + i}", saved, fromLaunch = false)!!
            assertFalse(tap.fromLaunch)
            saved = rememberConsumedTap(saved, tap)
        }
        assertEquals(CONSUMED_TAPS_MAX, saved.recent.size)
        // Process death: the bundle round-trips the two fields, and the system
        // hands back the ORIGINAL launch intent with its extras → no-op.
        val restored = ConsumedTaps(launch = saved.launch, recent = ArrayList(saved.recent))
        assertNull(openTaskFromIntent("task-a", "1000", restored, fromLaunch = true))
        // The newest onNewIntent tap is still consumed too…
        assertNull(openTaskFromIntent("task-${CONSUMED_TAPS_MAX + 2}", "${2000 + CONSUMED_TAPS_MAX + 2}", restored, fromLaunch = false))
        // …while a genuinely new nonce — even for task A — still opens.
        assertEquals("task-a", openTaskFromIntent("task-a", "9999", restored, fromLaunch = false)?.taskId)
    }

    @Test fun `the pinned launch marker survives a second restore and later taps`() {
        val launch = openTaskFromIntent("task-a", "1000", ConsumedTaps(), fromLaunch = true)!!
        var saved = rememberConsumedTap(ConsumedTaps(), launch)
        // First restore: the launch intent is rejected, so nothing re-pins it —
        // the saved state must carry it forward unchanged.
        assertNull(openTaskFromIntent("task-a", "1000", saved, fromLaunch = true))
        for (i in 0 until CONSUMED_TAPS_MAX * 2) {
            saved = rememberConsumedTap(saved, openTaskFromIntent("t$i", "$i", saved, fromLaunch = false)!!)
        }
        assertEquals(launch.marker, saved.launch)
        assertNull(openTaskFromIntent("task-a", "1000", saved, fromLaunch = true))
    }

    @Test fun `a launch tap superseded before it was handled is pinned as consumed`() {
        // onCreate read A; before App() consumed it an onNewIntent tap B replaced it.
        val launch = openTaskFromIntent("task-a", "1000", ConsumedTaps(), fromLaunch = true)!!
        var saved = ConsumedTaps()
        val newer = openTaskFromIntent("task-b", "2000", saved, fromLaunch = false)!!
        saved = rememberConsumedTap(saved, launch) // what readOpenTask does with the superseded tap
        saved = rememberConsumedTap(saved, newer)  // then App() consumes B
        assertEquals(launch.marker, saved.launch)
        assertEquals(listOf(newer.marker), saved.recent)
        assertNull(openTaskFromIntent("task-a", "1000", saved, fromLaunch = true))
    }

    @Test fun `an onNewIntent tap never replaces the pinned launch marker`() {
        val launch = OpenTaskTap("task-a", openTaskMarker("task-a", "1"), fromLaunch = true)
        val later = OpenTaskTap("task-b", openTaskMarker("task-b", "2"))
        val saved = rememberConsumedTap(rememberConsumedTap(ConsumedTaps(), launch), later)
        assertEquals(launch.marker, saved.launch)
        assertTrue(launch.marker in saved)
        assertTrue(later.marker in saved)
        assertFalse(openTaskMarker("task-c", "3") in saved)
    }
}

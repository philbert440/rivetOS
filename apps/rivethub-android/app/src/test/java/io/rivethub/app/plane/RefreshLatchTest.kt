package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshLatchTest {
    @Test fun `request while job is active coalesces instead of starting`() {
        val started = requestRefresh(RefreshLatch())
        assertTrue(started.start)
        assertTrue(started.latch.loading)
        assertTrue(started.latch.jobActive)
        val again = requestRefresh(started.latch)
        assertFalse(again.start)
        assertTrue(again.latch.again)
        assertEquals(started.latch.gen, again.latch.gen)
    }

    @Test fun `a discarded refresh leaves loading false and re-runs`() {
        var latch = requestRefresh(RefreshLatch()).latch
        latch = requestRefresh(latch).latch
        assertTrue(latch.again)
        val end = finishRefresh(latch, latch.gen)
        assertFalse(end.latch.loading)
        assertFalse(end.latch.jobActive)
        assertTrue(end.rerun)
    }

    @Test fun `finish without a coalesced request does not re-run`() {
        val latch = requestRefresh(RefreshLatch()).latch
        val end = finishRefresh(latch, latch.gen)
        assertFalse(end.latch.loading)
        assertFalse(end.rerun)
    }

    @Test fun `a superseded generation does not clear the new owner's latch`() {
        val first = requestRefresh(RefreshLatch())
        val superseded = supersedeRefresh(first.latch)
        val end = finishRefresh(superseded, first.latch.gen)
        assertFalse(end.rerun)
        assertEquals(superseded.gen, end.latch.gen)
        assertFalse(end.latch.loading)
    }

    @Test fun `request bumps generation and sets loading`() {
        val a = requestRefresh(RefreshLatch())
        assertEquals(1, a.latch.gen)
        val b = requestRefresh(RefreshLatch(jobActive = false, gen = 4))
        assertEquals(5, b.latch.gen)
        assertTrue(b.latch.loading)
    }

    @Test fun `throw before try can't latch`() {
        val started = requestRefresh(RefreshLatch())
        val stuck = requestRefresh(started.latch)
        assertFalse(stuck.start)
        assertTrue(started.latch.jobActive)
        val end = finishRefresh(started.latch, started.latch.gen)
        assertFalse(end.latch.jobActive)
        assertFalse(end.latch.loading)
        assertTrue(requestRefresh(end.latch).start)
    }
}

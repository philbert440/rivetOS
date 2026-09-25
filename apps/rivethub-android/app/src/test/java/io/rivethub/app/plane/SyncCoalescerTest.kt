package io.rivethub.app.plane

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncCoalescerTest {
    @Test
    fun `onRequest onRequest onRearm onRearm returns true false true false`() {
        val c = SyncCoalescer()
        assertTrue(c.onRequest())
        assertFalse(c.onRequest())
        assertTrue(c.onRearm())
        assertFalse(c.onRearm())
    }

    @Test
    fun `onRequest onRearm onRequest onRearm onRearm returns true true true true false`() {
        val c = SyncCoalescer()
        assertTrue(c.onRequest())
        assertTrue(c.onRearm())
        // The retry closed the window. This request sends and opens a new one.
        assertTrue(c.onRequest())
        assertTrue(c.onRearm())
        assertFalse(c.onRearm())
    }

    @Test
    fun `onRequest onRequest onRearm onRequest returns true false true true`() {
        val c = SyncCoalescer()
        assertTrue(c.onRequest())
        assertFalse(c.onRequest())
        assertTrue(c.onRearm())
        assertTrue(c.onRequest())
    }

    @Test
    fun `onRequest onRequest abandon onRearm onRequest returns true false then false true`() {
        val c = SyncCoalescer()
        assertTrue(c.onRequest())
        assertFalse(c.onRequest())
        c.abandon()
        assertFalse(c.onRearm())
        assertTrue(c.onRequest())
    }

    @Test
    fun `onRequest onRequest onRearm onRearm returns true false true false with snapshots interleaved`() {
        val c = SyncCoalescer()
        // Snapshots have no API. An unsolicited from-zero frame cannot cancel
        // the retry or complete the send, so nothing is called for one.
        assertTrue(c.javaClass.methods.none { it.name == "onSnapshot" })
        assertTrue(c.onRequest()) // A
        // Snapshot X (another subscriber, subscribe, reconnect, turn-complete).
        assertFalse(c.onRequest()) // B inside A's window
        // Snapshot(A) would have been next. Still nothing to call.
        assertTrue(c.onRearm()) // A's one retry
        assertFalse(c.onRearm()) // no trailing send for a throttled T
    }
}

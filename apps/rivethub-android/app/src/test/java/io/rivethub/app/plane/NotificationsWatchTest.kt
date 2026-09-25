package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationsWatchTest {
    private val a = "https://a.example"
    private val b = "https://b.example"

    /** Reconcile to [url]/[gen] and report the subscribe as succeeding. */
    private fun settle(w: NotificationsWatch, url: String, gen: Int): Pair<NotificationsWatch, NotificationsWatchStep> {
        val step = reconcileNotificationsWatch(w, notificationsWatchKey(url, gen))
        return notificationsWatchOpened(step.watch, ok = step.open != null) to step
    }

    @Test fun `key trims the entry url and is null without one`() {
        assertNull(notificationsWatchKey("  ", 1))
        assertEquals(NotificationsWatchKey(a, 3), notificationsWatchKey(" $a/ ", 3))
    }

    @Test fun `first entry opens without clearing and the same key is then a no-op`() {
        val (w, step) = settle(NotificationsWatch(), a, 1)
        assertFalse(step.close)
        assertEquals(NotificationsWatchKey(a, 1), step.open)
        assertFalse(step.clearInbox)
        assertTrue(w.socketOpen)
        val again = reconcileNotificationsWatch(w, notificationsWatchKey("$a/", 1))
        assertSame(w, again.watch)
        assertFalse(again.close)
        assertNull(again.open)
    }

    @Test fun `entry A to B closes A opens B under a new generation and clears the inbox`() {
        val (wa, _) = settle(NotificationsWatch(), a, 1)
        val step = reconcileNotificationsWatch(wa, notificationsWatchKey(b, 1))
        assertTrue(step.close)
        assertEquals(NotificationsWatchKey(b, 1), step.open)
        assertTrue(step.clearInbox)
        assertEquals(wa.gen + 1, step.watch.gen)
    }

    @Test fun `a failed health check leaves the key on B so a later reconcile keeps B`() {
        // Settings "Test connection" persists B before probing; the probe
        // failing changes nothing the key is derived from.
        val (wa, _) = settle(NotificationsWatch(), a, 1)
        val (wb, _) = settle(wa, b, 1)
        val afterFail = reconcileNotificationsWatch(wb, notificationsWatchKey(b, 1))
        assertSame(wb, afterFail.watch)
        assertNull(afterFail.open)
        assertFalse(afterFail.clearInbox)
        assertEquals(NotificationsWatchKey(b, 1), wb.key)
    }

    @Test fun `a late frame from the superseded A socket is rejected by generation`() {
        val (wa, _) = settle(NotificationsWatch(), a, 1)
        val genA = wa.gen
        assertTrue(acceptNotificationFrame(wa, genA))
        val (wb, _) = settle(wa, b, 1)
        assertFalse(acceptNotificationFrame(wb, genA))
        assertTrue(acceptNotificationFrame(wb, wb.gen))
    }

    @Test fun `identity bump on the same entry resubscribes but keeps the inbox`() {
        val (w1, _) = settle(NotificationsWatch(), a, 1)
        val step = reconcileNotificationsWatch(w1, notificationsWatchKey(a, 2))
        assertTrue(step.close)
        assertEquals(NotificationsWatchKey(a, 2), step.open)
        assertFalse(step.clearInbox)
        assertFalse(acceptNotificationFrame(notificationsWatchOpened(step.watch, true), w1.gen))
    }

    @Test fun `a subscribe that threw is retried on the same key without clearing`() {
        val first = reconcileNotificationsWatch(NotificationsWatch(), notificationsWatchKey(a, 1))
        val failed = notificationsWatchOpened(first.watch, ok = false)
        assertFalse(failed.socketOpen)
        val retry = reconcileNotificationsWatch(failed, notificationsWatchKey(a, 1))
        assertFalse(retry.close)
        assertEquals(NotificationsWatchKey(a, 1), retry.open)
        assertFalse(retry.clearInbox)
        assertEquals(failed.gen + 1, retry.watch.gen)
    }

    @Test fun `clearing the entry closes and clears and close drops in-flight frames`() {
        val (w, _) = settle(NotificationsWatch(), a, 1)
        val gone = reconcileNotificationsWatch(w, notificationsWatchKey("", 1))
        assertTrue(gone.close)
        assertNull(gone.open)
        assertTrue(gone.clearInbox)
        assertFalse(acceptNotificationFrame(gone.watch, w.gen))
        val shut = closeNotificationsWatch(w)
        assertNull(shut.key)
        assertFalse(shut.socketOpen)
        assertFalse(acceptNotificationFrame(shut, w.gen))
        assertFalse(acceptNotificationFrame(shut, shut.gen))
        // Nothing held and nothing wanted: a no-op.
        assertSame(shut, reconcileNotificationsWatch(shut, null).watch)
    }
}

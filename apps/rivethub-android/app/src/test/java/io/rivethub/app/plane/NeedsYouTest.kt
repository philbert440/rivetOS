package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors rivethub-web `spaces-canvas/canvas-commands.test.ts` needs-you cases. */
class NeedsYouTest {
    @Test
    fun `sessions already waiting when the roster lands are not announced`() {
        val e = NeedsEpisodes()
        assertEquals(emptyList<String>(), e.reconcile(setOf("a"), now = 10, ready = false))
        assertEquals(emptyList<String>(), e.reconcile(setOf("a", "b"), now = 20, ready = true))
        assertEquals(listOf("c"), e.reconcile(setOf("a", "b", "c"), now = 30))
    }

    @Test
    fun `a session that stops and starts waiting again is a new episode`() {
        val e = NeedsEpisodes()
        e.reconcile(emptySet(), now = 0)
        assertEquals(listOf("a"), e.reconcile(setOf("a"), now = 10))
        assertEquals(emptyList<String>(), e.reconcile(setOf("a"), now = 20))
        assertEquals(10L, e.since["a"])
        e.reconcile(emptySet(), now = 30)
        assertNull(e.since["a"])
        assertEquals(listOf("a"), e.reconcile(setOf("a"), now = 40))
        assertEquals(40L, e.since["a"])
    }

    @Test
    fun `waiting rows are oldest first and only blocked ones`() {
        val items = listOf(
            ChatItem("codex:new", ChatItemKind.HARNESS, "n", sessionId = "codex:new", blocked = true, updatedAt = 5),
            ChatItem("codex:old", ChatItemKind.HARNESS, "o", sessionId = "codex:old", blocked = true, updatedAt = 9),
            ChatItem("codex:idle", ChatItemKind.HARNESS, "i", sessionId = "codex:idle"),
        )
        val rows = waitingRows(items, since = mapOf("codex:old" to 1L))
        assertEquals(listOf("codex:old", "codex:new"), rows.map { it.id })
    }

    @Test
    fun `next waiting cycles from the open chat and starts at the oldest elsewhere`() {
        val waiting = listOf(WaitingRow("b", 20), WaitingRow("a", 10), WaitingRow("c", 30))
        assertEquals("a", nextWaitingId(waiting, null))
        assertEquals("a", nextWaitingId(waiting, "elsewhere"))
        assertEquals("b", nextWaitingId(waiting, "a"))
        assertEquals("a", nextWaitingId(waiting, "c"))
        assertNull(nextWaitingId(emptyList(), "a"))
    }

    @Test
    fun `next waiting matches the open chat by native id too`() {
        val waiting = listOf(WaitingRow("codex:a", 10), WaitingRow("codex:b", 20))
        assertEquals("codex:b", nextWaitingId(waiting, "a"))
    }

    @Test
    fun `session notices skip the chat on screen only while the app is in front`() {
        assertFalse(shouldNotifySession(enabled = true, appResumed = true, sessionId = "codex:a", openSessionKey = "codex:a"))
        assertTrue(shouldNotifySession(enabled = true, appResumed = false, sessionId = "codex:a", openSessionKey = "codex:a"))
        assertTrue(shouldNotifySession(enabled = true, appResumed = true, sessionId = "codex:b", openSessionKey = "codex:a"))
        assertFalse(shouldNotifySession(enabled = false, appResumed = false, sessionId = "codex:a", openSessionKey = null))
    }
}

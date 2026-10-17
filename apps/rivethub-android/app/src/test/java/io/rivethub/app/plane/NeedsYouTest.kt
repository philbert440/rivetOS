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

    @Test
    fun `a session missing from the list keeps its episode and is not re-announced`() {
        val e = NeedsEpisodes()
        e.reconcile(emptySet(), now = 0)
        assertEquals(listOf("a"), e.reconcile(setOf("a"), now = 10, present = setOf("a", "b")))
        // Its node timed out: "a" is gone from the list, not resolved.
        assertEquals(emptyList<String>(), e.reconcile(emptySet(), now = 20, present = setOf("b")))
        assertEquals(10L, e.since["a"])
        assertEquals(emptyList<String>(), e.reconcile(setOf("a"), now = 30, present = setOf("a", "b")))
        assertEquals(10L, e.since["a"])
        // Listed and no longer waiting: the episode ends.
        e.reconcile(emptySet(), now = 40, present = setOf("a", "b"))
        assertNull(e.since["a"])
    }

    @Test
    fun `a node whose roster lands late primes instead of announcing`() {
        val e = NeedsEpisodes()
        e.reconcile(emptySet(), now = 0)
        val settled = setOf("a")
        assertEquals(
            listOf("a"),
            e.reconcile(setOf("a", "late"), now = 10, settled = { it in settled }),
        )
        // The late node has settled; its already-waiting session stays quiet.
        assertEquals(emptyList<String>(), e.reconcile(setOf("a", "late"), now = 20))
        assertEquals(listOf("new"), e.reconcile(setOf("a", "late", "new"), now = 30))
    }

    @Test
    fun `clear primes the next roster again`() {
        val e = NeedsEpisodes()
        e.reconcile(emptySet(), now = 0)
        assertEquals(listOf("a"), e.reconcile(setOf("a"), now = 10))
        e.clear()
        assertNull(e.since["a"])
        assertEquals(emptyList<String>(), e.reconcile(setOf("b"), now = 20))
        assertEquals(listOf("c"), e.reconcile(setOf("b", "c"), now = 30))
    }

    @Test
    fun `status frames block a session until every source moves on`() {
        val b = StatusBlocks()
        assertTrue(b.onStatus("grok:a", "blocked", "protocol"))
        assertTrue(b.isBlocked("grok:a"))
        assertFalse(b.onStatus("grok:a", "blocked", "protocol"))
        // A transcript "working" frame mid-permission does not clear it.
        assertFalse(b.onStatus("grok:a", "working", "transcript"))
        assertTrue(b.isBlocked("grok:a"))
        assertTrue(b.onStatus("grok:a", "working", "protocol"))
        assertFalse(b.isBlocked("grok:a"))
        assertTrue(b.isEmpty)
    }

    @Test
    fun `status blocks follow a rekey and drop on end`() {
        val b = StatusBlocks()
        b.onStatus("opencode:old", "blocked", "protocol")
        assertTrue(b.onSessionUpdated("opencode:new", "active", previousSessionId = "opencode:old"))
        assertFalse(b.isBlocked("opencode:old"))
        assertTrue(b.isBlocked("opencode:new"))
        assertFalse(b.onSessionUpdated("opencode:new", "active"))
        assertTrue(b.onSessionUpdated("opencode:new", "ended"))
        assertFalse(b.isBlocked("opencode:new"))
    }

    @Test
    fun `status blocks surface a session as waiting`() {
        val items = listOf(
            ChatItem("grok:a", ChatItemKind.HARNESS, "a", sessionId = "grok:a"),
            ChatItem("grok:b", ChatItemKind.HARNESS, "b", sessionId = "grok:b"),
            ChatItem("grok:c", ChatItemKind.HARNESS, "c", sessionId = "grok:c", status = "ended"),
        )
        val b = StatusBlocks()
        b.onStatus("grok:a", "blocked", "protocol")
        b.onStatus("grok:c", "blocked", "protocol")
        val out = withStatusBlocks(items, b)
        assertEquals(listOf("grok:a"), out.filter { it.blocked }.map { it.key })
        assertEquals(listOf("grok:a"), waitingRows(out, emptyMap()).map { it.id })
        b.onStatus("grok:a", "idle", "protocol")
        assertTrue(withStatusBlocks(items, b).none { it.blocked })
        assertEquals(items, withStatusBlocks(items, null))
    }

    @Test
    fun `reset drops every status block and reports them`() {
        val b = StatusBlocks()
        b.onStatus("grok:a", "blocked", "protocol")
        b.onStatus("grok:b", "blocked", "transcript")
        assertEquals(setOf("grok:a", "grok:b"), b.reset())
        assertTrue(b.isEmpty)
        assertFalse(b.isBlocked("grok:a"))
        assertEquals(emptySet<String>(), b.reset())
    }

    @Test
    fun `a block re-reported right after a reconnect is the same episode`() {
        val e = NeedsEpisodes()
        e.reconcile(emptySet(), now = 0)
        assertEquals(listOf("a"), e.reconcile(setOf("a"), now = 10))
        // Reconnect drops the status block; the episode is held, not ended.
        e.hold(listOf("a"), until = 10 + RECONNECT_BLOCK_GRACE_MS)
        assertEquals(emptyList<String>(), e.reconcile(emptySet(), now = 20, present = setOf("a")))
        assertEquals(10L, e.since["a"])
        // Same block comes back: no second notice, original stamp kept.
        assertEquals(emptyList<String>(), e.reconcile(setOf("a"), now = 30, present = setOf("a")))
        assertEquals(10L, e.since["a"])
        // Once it is back, the hold is spent: clearing ends the episode as usual.
        assertEquals(emptyList<String>(), e.reconcile(emptySet(), now = 40, present = setOf("a")))
        assertNull(e.since["a"])
    }

    @Test
    fun `a held episode ends once the grace window passes`() {
        val e = NeedsEpisodes()
        e.reconcile(emptySet(), now = 0)
        assertEquals(listOf("a"), e.reconcile(setOf("a"), now = 10))
        e.hold(listOf("a", "never-waited"), until = 100)
        assertNull(e.since["never-waited"])
        assertEquals(emptyList<String>(), e.reconcile(emptySet(), now = 50, present = setOf("a")))
        assertEquals(10L, e.since["a"])
        assertEquals(emptyList<String>(), e.reconcile(emptySet(), now = 100, present = setOf("a")))
        assertNull(e.since["a"])
        // A genuinely new wait after that is announced.
        assertEquals(listOf("a"), e.reconcile(setOf("a"), now = 200, present = setOf("a")))
    }
}

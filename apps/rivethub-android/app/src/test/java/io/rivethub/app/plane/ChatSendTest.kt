package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatSendTest {
    @Test fun `a draft first send injects into the PTY`() {
        val action = chatSendAction(draft = true, sessionId = "draft-1", text = "hello")
        assertEquals(ChatSendAction.Inject("draft-1", "hello"), action)
    }

    @Test fun `an adopted session uses sendTurn`() {
        val action = chatSendAction(draft = false, sessionId = "claude-code:abc", text = "hello")
        assertEquals(ChatSendAction.SendTurn("claude-code:abc", "hello"), action)
    }

    @Test fun `commanded spawn falls back to session-only`() {
        val attempts = spawnAttempts("draft-1", "claude", "fable", "high")
        assertEquals(2, attempts.size)
        assertEquals("claude", attempts[0].command)
        assertEquals("fable", attempts[0].model)
        assertNull(attempts[1].command)
        assertEquals("draft-1", attempts[1].session)
    }

    @Test fun `API-only agent spawn is session-only`() {
        val attempts = spawnAttempts("draft-1", null)
        assertEquals(listOf(SpawnAttempt("draft-1")), attempts)
        assertEquals(listOf(SpawnAttempt("draft-1")), spawnAttempts("draft-1", "  "))
    }

    @Test fun `LRU eviction retries inject once`() {
        assertEquals(InjectTry.RetryAfterEviction, nextInjectTry(failed = true, alreadyRetried = false))
        assertNull(nextInjectTry(failed = true, alreadyRetried = true))
        assertNull(nextInjectTry(failed = false, alreadyRetried = false))
    }

    @Test fun `gate item is DRAFT until adopted then HARNESS`() {
        val draft = chatItemForGate("d1", draft = true, harnessId = "claude-code", title = "new")
        assertEquals(ChatItemKind.DRAFT, draft.kind)
        assertNull(draft.sessionId)
        val live = chatItemForGate("claude-code:d1", draft = false, harnessId = "claude-code", title = "new")
        assertEquals(ChatItemKind.HARNESS, live.kind)
        assertEquals("claude-code:d1", live.sessionId)
        val desc = listOf(
            io.rivethub.app.gateway.HarnessDescriptor(
                "claude-code",
                io.rivethub.app.gateway.HarnessCapabilities(interrupt = true, listSessions = true),
            ),
        )
        assertTrue(!harnessGate(draft, desc).canInterrupt)
        assertTrue(harnessGate(live, desc).canInterrupt)
    }
}

package io.rivethub.app.plane

import io.rivethub.app.gateway.WsStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    @Test fun `agentId attempt carries the command and not model or effort`() {
        val attempts = spawnAttempts("draft-1", "claude", "fable", "high", "reviewer")
        assertEquals(
            listOf(
                SpawnAttempt("draft-1", command = "claude", agentId = "reviewer"),
                SpawnAttempt("draft-1", "claude", "fable", "high"),
                SpawnAttempt("draft-1"),
            ),
            attempts,
        )
        assertEquals("claude", attempts[0].command)
        assertNull(attempts[0].model)
        assertNull(attempts[0].effort)
        assertEquals(false, attempts[0].force)
    }

    @Test fun `agentId with a blank command drops the middle attempt`() {
        assertEquals(
            listOf(
                SpawnAttempt("draft-1", agentId = "reviewer"),
                SpawnAttempt("draft-1"),
            ),
            spawnAttempts("draft-1", "  ", null, null, " reviewer "),
        )
    }

    @Test fun `blank agentId keeps the commanded fallback order`() {
        assertEquals(
            spawnAttempts("draft-1", "claude", "fable", "high"),
            spawnAttempts("draft-1", "claude", "fable", "high", "  "),
        )
        assertEquals(
            listOf(SpawnAttempt("draft-1")),
            spawnAttempts("draft-1", null, null, null, null),
        )
    }

    @Test fun `spawnConflict maps only 409 texts`() {
        val hosted = "agent \"reviewer\" is hosted on ct115"
        val recorded = "session runs in /tmp/old; edit the agent or start a new conversation"
        val running = "session is running in /x; edit the agent or start a new conversation"
        assertNull(spawnConflict(404, "agent not found"))
        assertNull(spawnConflict(503, "agent registry unavailable"))
        assertNull(spawnConflict(500, hosted))
        assertEquals(SpawnConflict.HostedElsewhere, spawnConflict(409, hosted))
        assertEquals(
            SpawnConflict.NoDirectory,
            spawnConflict(409, "agent \"reviewer\" has no directory"),
        )
        assertEquals(SpawnConflict.RecordedDir, spawnConflict(409, recorded))
        assertEquals(SpawnConflict.Other, spawnConflict(409, running))
        assertEquals(SpawnConflict.Other, spawnConflict(409, null))
    }

    @Test fun `forcedRetry sets force and keeps the rest of the attempt`() {
        val attempt = SpawnAttempt("draft-1", command = "claude", agentId = "reviewer")
        val forced = forcedRetry(attempt)
        assertEquals(true, forced.force)
        assertEquals("reviewer", forced.agentId)
        assertEquals("draft-1", forced.session)
        assertEquals("claude", forced.command)
        assertNull(forced.model)
        assertNull(forced.effort)
        assertEquals(false, attempt.force)
    }

    @Test fun `RecordedDir stops the attempt loop`() {
        assertTrue(spawnConflictStops(SpawnConflict.RecordedDir))
    }

    @Test fun `HostedElsewhere stops the attempt loop`() {
        assertTrue(spawnConflictStops(SpawnConflict.HostedElsewhere))
    }

    @Test fun `NoDirectory stops the attempt loop`() {
        assertTrue(spawnConflictStops(SpawnConflict.NoDirectory))
    }

    @Test fun `Other does not stop the attempt loop`() {
        assertFalse(spawnConflictStops(SpawnConflict.Other))
    }

    @Test fun `a stopping conflict keeps the den error`() {
        val hosted = "agent \"reviewer\" is hosted on ct115"
        val missing = "agent \"reviewer\" has no directory"
        val recorded = "session runs in /tmp/old; edit the agent or start a new conversation"
        assertEquals(hosted, spawnStopError(SpawnConflict.HostedElsewhere, hosted, 409))
        assertEquals(missing, spawnStopError(SpawnConflict.NoDirectory, missing, 409))
        assertEquals("HTTP 409", spawnStopError(SpawnConflict.HostedElsewhere, null, 409))
        assertNull(spawnStopError(SpawnConflict.RecordedDir, recorded, 409))
        assertNull(spawnStopError(SpawnConflict.Other, hosted, 409))
    }

    @Test fun `agentId fallback surfaces den text except 404 and a stopping 409`() {
        val noHarness = "agent has no harness and no command was given"
        val badModel = "agent \"reviewer\" model must be a 1-64 token"
        val directory = "could not create agent directory: directory must be an absolute path"
        val running = "session is running in /x; edit the agent or start a new conversation"
        val recorded = "session runs in /tmp/old; edit the agent or start a new conversation"
        assertEquals(noHarness, agentAttemptFallbackError(400, noHarness))
        assertEquals(badModel, agentAttemptFallbackError(400, badModel))
        assertEquals(directory, agentAttemptFallbackError(500, directory))
        assertEquals("agent registry unavailable", agentAttemptFallbackError(503, "agent registry unavailable"))
        assertEquals(running, agentAttemptFallbackError(409, running))
        assertEquals("HTTP 400", agentAttemptFallbackError(400, null))
        assertNull(agentAttemptFallbackError(404, "agent not found"))
        assertNull(agentAttemptFallbackError(409, recorded))
        assertNull(agentAttemptFallbackError(409, "agent \"reviewer\" is hosted on ct115"))
        assertNull(agentAttemptFallbackError(409, "agent \"reviewer\" has no directory"))
    }

    @Test fun `fallback success keeps the surfaced den error`() {
        val registry = "agent registry unavailable"
        val directory = "could not create agent directory: directory must be an absolute path"
        val running = "session is running in /x; edit the agent or start a new conversation"
        assertEquals(registry, spawnSuccessError(registry, registry))
        assertEquals(directory, spawnSuccessError(directory, directory))
        assertEquals(running, spawnSuccessError(running, running))
        assertEquals("older", spawnSuccessError("older", registry))
        assertNull(spawnSuccessError(null, registry))
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

    @Test fun `composer stays enabled when error is set`() {
        assertTrue(composerIsEnabled(WsStatus.OPEN, "timed out"))
        assertTrue(composerIsEnabled(WsStatus.CONNECTING, "boom"))
    }

    @Test fun `composer disables only when the socket is closed`() {
        assertFalse(composerIsEnabled(WsStatus.CLOSED, null))
        assertFalse(composerIsEnabled(WsStatus.CLOSED, "boom"))
        assertTrue(composerIsEnabled(WsStatus.OPEN, null))
    }

    @Test fun `error clears on input`() {
        val edit = composerOnInput("hello")
        assertEquals("hello", edit.value)
        assertNull(edit.error)
        assertNull(composerOnSendAttempt())
    }

    @Test fun `409 is stale only when the transcript ends with an assistant turn`() {
        val u = io.rivethub.app.gateway.HarnessTranscriptTurn(role = "user", text = "hi")
        val a = io.rivethub.app.gateway.HarnessTranscriptTurn(role = "assistant", text = "PONG")
        assertTrue(serverInFlightIsStale(listOf(u, a)))
        assertTrue(serverInFlightIsStale(listOf(u, a, u))) // trailing optimistic user turn
        assertFalse(serverInFlightIsStale(listOf(u, u)))   // previous turn not answered yet
        assertFalse(serverInFlightIsStale(emptyList()))
    }

    @Test fun `agent status line mirrors the desktop live bubble copy`() {
        assertEquals("thinking…", agentStatusLine("working", "thinking", null))
        assertEquals("running Bash…", agentStatusLine("working", "tool", "Bash"))
        assertEquals("writing…", agentStatusLine("working", "writing", null))
        assertEquals("waiting for you", agentStatusLine("blocked", "prompt", null))
        assertEquals("waiting for you", agentStatusLine("working", "prompt", null))
        assertNull(agentStatusLine("idle", null, null))
    }
}

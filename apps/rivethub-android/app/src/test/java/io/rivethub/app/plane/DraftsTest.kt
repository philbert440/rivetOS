package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessSessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DraftsTest {
    private val uuid = "a1b2c3d4-1111-4222-8333-444455556666"
    private val other = "b2c3d4e5-2222-4333-8444-555566667777"
    private val canonical = "claude-code:$uuid"
    private val rotated = "claude-code:$other"

    private fun summary(sessionId: String, supersedes: String? = null) = HarnessSessionSummary(
        sessionId = sessionId,
        harnessId = "claude-code",
        createdAt = "2026-08-08T00:00:00.000Z",
        updatedAt = "2026-08-08T00:05:00.000Z",
        status = "idle",
        supersedes = supersedes,
    )

    @Test fun `newDraftId is a bare UUID`() {
        val id = newDraftId()
        assertTrue(id.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")))
        assertFalseColon(id)
        assertNotEquals(newDraftId(), newDraftId())
    }

    @Test fun `adopt rekeys a bare draft onto the canonical id`() {
        val rekey = adopt(uuid, summary(canonical))
        assertEquals(Rekey(uuid, canonical), rekey)
    }

    @Test fun `adopt honours supersedes lineage`() {
        val rekey = adopt(canonical, summary(rotated, supersedes = canonical))
        assertEquals(Rekey(canonical, rotated), rekey)
    }

    @Test fun `adoptSessionKey follows previousSessionId rotation`() {
        val moved = adoptSessionKey(rotated, canonical, listOf(canonical))
        assertEquals(listOf(Rekey(canonical, rotated)), moved)
    }

    @Test fun `never adopts another harness sharing the native half`() {
        val grok = "grok-build:$uuid"
        assertEquals(emptyList<Rekey>(), adoptSessionKey(canonical, null, listOf(grok)))
        assertNull(adopt(grok, summary(canonical)))
    }

    @Test fun `still adopts the bare twin while leaving a foreign canonical alone`() {
        val grok = "grok-build:$uuid"
        val moved = adoptSessionKey(canonical, null, listOf(grok, uuid))
        assertEquals(listOf(Rekey(uuid, canonical)), moved)
    }

    @Test fun `already-canonical tracked key is a no-op`() {
        assertEquals(emptyList<Rekey>(), adoptSessionKey(canonical, null, listOf(canonical)))
        assertNull(adopt(canonical, summary(canonical)))
    }

    @Test fun `untracked previous is ignored`() {
        assertEquals(emptyList<Rekey>(), adoptSessionKey(rotated, canonical, emptyList()))
    }

    private fun assertFalseColon(id: String) {
        org.junit.Assert.assertFalse(id.contains(':'))
    }
}

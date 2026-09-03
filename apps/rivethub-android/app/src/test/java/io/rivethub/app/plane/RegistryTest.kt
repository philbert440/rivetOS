package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessSessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RegistryTest {
    private val uuidA = "a1b2c3d4-1111-4222-8333-444455556666"
    private val uuidB = "b2c3d4e5-2222-4333-8444-555566667777"
    private val uuidC = "c3d4e5f6-3333-4444-8555-666677778888"

    private fun summary(
        native: String,
        title: String? = null,
        status: String = "idle",
        cwd: String? = null,
    ) = HarnessSessionSummary(
        sessionId = "claude-code:$native",
        harnessId = "claude-code",
        title = title,
        cwd = cwd,
        createdAt = "2026-08-08T00:00:00.000Z",
        updatedAt = "2026-08-08T00:05:00.000Z",
        status = status,
    )

    @Test fun `mergeSessionCreated inserts at the front`() {
        val created = summary(uuidB, title = "brand new", status = "active")
        assertEquals(listOf(created), mergeSessionCreated(emptyList(), created))
        val existing = listOf(summary(uuidA))
        val merged = mergeSessionCreated(existing, created)
        assertEquals(2, merged.size)
        assertEquals(created, merged[0])
        assertEquals(1, existing.size)
    }

    @Test fun `merge overwrites in place and does not duplicate`() {
        val created = summary(uuidA, title = "v1", status = "active")
        val once = mergeSessionCreated(emptyList(), created)
        assertEquals(1, mergeSessionCreated(once, created).size)
        val fromRefetch = listOf(summary(uuidA, title = "from GET", status = "idle"), summary(uuidB))
        val after = mergeSessionCreated(fromRefetch, summary(uuidA, title = "from event", status = "active"))
        assertEquals(2, after.size)
        assertEquals("from event", after.find { it.sessionId == "claude-code:$uuidA" }!!.title)
        assertEquals("active", after.find { it.sessionId == "claude-code:$uuidA" }!!.status)
    }

    @Test fun `merge replaces optional fields wholesale`() {
        val existing = listOf(summary(uuidA, title = "old", cwd = "/tmp/old"))
        val next = mergeSessionCreated(existing, summary(uuidA, title = null, cwd = null, status = "idle"))
        assertNullTitle(next.single())
        assertEquals(null, next.single().cwd)
    }

    @Test fun `patchSessionUpdated patches status in place`() {
        val list = listOf(summary(uuidA, status = "idle"), summary(uuidB, status = "idle"))
        val patched = patchSessionUpdated(list, SessionUpdatedPatch("claude-code:$uuidA", "active"))
        assertEquals("active", patched.find { it.sessionId == "claude-code:$uuidA" }!!.status)
        assertEquals("idle", patched.find { it.sessionId == "claude-code:$uuidB" }!!.status)
    }

    @Test fun `unknown id returns the same list reference`() {
        val list = listOf(summary(uuidA))
        val untouched = patchSessionUpdated(list, SessionUpdatedPatch("claude-code:$uuidC", "ended"))
        assertSame(list, untouched)
    }

    @Test fun `native-id rotation rewrites sessionId`() {
        val rotated = patchSessionUpdated(
            listOf(summary(uuidA, status = "active")),
            SessionUpdatedPatch(
                sessionId = "claude-code:$uuidB",
                status = "idle",
                previousSessionId = "claude-code:$uuidA",
            ),
        )
        assertEquals(1, rotated.size)
        assertEquals("claude-code:$uuidB", rotated[0].sessionId)
        assertEquals("idle", rotated[0].status)
        assertEquals("claude-code", rotated[0].harnessId)
    }

    @Test fun `rotation racing a create under the new id keeps one row`() {
        val list = listOf(summary(uuidA, status = "active"), summary(uuidB, status = "idle"))
        val rotated = patchSessionUpdated(
            list,
            SessionUpdatedPatch(
                sessionId = "claude-code:$uuidB",
                status = "idle",
                previousSessionId = "claude-code:$uuidA",
            ),
        )
        assertEquals(1, rotated.size)
        assertEquals("claude-code:$uuidB", rotated.single().sessionId)
    }

    @Test fun `applyRegistryEvent seeds create and ignores other types`() {
        val created = summary(uuidA, title = "live")
        val seeded = applyRegistryEvent(null, "session-created", created.sessionId, summary = created)
        assertEquals(listOf(created), seeded)
        val active = applyRegistryEvent(seeded, "session-updated", created.sessionId, status = "active")
        assertEquals("active", active!!.single().status)
        assertEquals(seeded, applyRegistryEvent(seeded, "turn-complete", created.sessionId))
        assertTrue(applyRegistryEvent(null, "session-updated", created.sessionId, status = "active") == null)
    }

    private fun assertNullTitle(s: HarnessSessionSummary) {
        org.junit.Assert.assertNull(s.title)
    }
}

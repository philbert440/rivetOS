package dev.rivet.app.data.harness

import dev.rivet.app.ui.pages.terminal.DenHarnessClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Per-session plane selection and its no-regression rule: driver-owned rows go
 * to the control plane, every other row keeps the legacy binding, and a node
 * with no driver registry behaves exactly as it did before.
 *
 * Kotlin twin of `apps/rivethub-web/src/lib/harness-chat.test.ts`.
 */
class HarnessPlaneTest {

    private fun summary(
        sessionId: String,
        title: String? = null,
        updatedAt: String? = "2026-08-09T10:00:00.000Z",
        status: HarnessStatus = HarnessStatus.IDLE,
    ) = HarnessSessionSummary(
        sessionId = sessionId,
        harnessId = HarnessSessionIds.parse(sessionId).harnessId,
        title = title,
        cwd = null,
        createdAt = null,
        updatedAt = updatedAt,
        status = status,
    )

    private fun legacy(id: String, command: String = "grok", title: String = "t", updated: Long = 1L) =
        DenHarnessClient.Session(id = id, command = command, title = title, updatedAt = updated)

    private fun descriptors(
        vararg pairs: Pair<String, HarnessCapabilities>,
    ) = pairs.map { HarnessDescriptor(it.first, it.second) }

    private val fullCaps = HarnessCapabilities(
        interrupt = true,
        resume = true,
        approvals = false,
        liveStream = true,
        listSessions = true,
    )

    // ---- row merge -----------------------------------------------------------

    @Test
    fun `a driver-owned row wins over the legacy scan and keeps its command`() {
        val rows = HarnessPlane.rows(
            harnessSessions = listOf(summary("claude-code:aaa", title = "plane title")),
            legacySessions = listOf(legacy("aaa", command = "claude", title = "legacy title")),
        )
        assertEquals(1, rows.size)
        val row = rows.single()
        assertEquals("aaa", row.key)
        assertEquals(ChatRowKind.HARNESS, row.kind)
        assertEquals("plane title", row.title)
        assertEquals("claude-code:aaa", row.sessionId)
        // The on-disk row's own command wins over the roster fallback.
        assertEquals("claude", row.command)
    }

    @Test
    fun `an unclaimed row stays legacy so nothing disappears from the drawer`() {
        val rows = HarnessPlane.rows(
            harnessSessions = listOf(summary("claude-code:aaa")),
            legacySessions = listOf(legacy("aaa"), legacy("bbb", command = "hermes")),
        )
        assertEquals(setOf("aaa", "bbb"), rows.map { it.key }.toSet())
        assertEquals(ChatRowKind.LEGACY, rows.single { it.key == "bbb" }.kind)
        assertNull(rows.single { it.key == "bbb" }.sessionId)
    }

    @Test
    fun `no descriptors means every row is legacy - the no-regression path`() {
        val rows = HarnessPlane.rows(emptyList(), listOf(legacy("aaa"), legacy("bbb")))
        assertTrue(rows.all { it.kind == ChatRowKind.LEGACY })
        rows.forEach { assertFalse(HarnessPlane.gate(it, emptyList()).bound) }
    }

    @Test
    fun `a plane row the legacy scan never saw falls back to the roster command`() {
        val row = HarnessPlane.rows(listOf(summary("grok-build:zzz")), emptyList()).single()
        assertEquals("grok", row.command)
        assertEquals("zzz", row.title) // no title anywhere → the key itself
    }

    @Test
    fun `a malformed canonical id is skipped, not shown under an unjoinable key`() {
        val broken = HarnessSessionSummary(
            sessionId = "not-a-session-id",
            harnessId = "claude-code",
            title = null,
            cwd = null,
            createdAt = null,
            updatedAt = null,
            status = HarnessStatus.IDLE,
        )
        assertTrue(HarnessPlane.rows(listOf(broken), emptyList()).isEmpty())
    }

    @Test
    fun `rows are newest first and an unparseable timestamp does not throw a row away`() {
        val rows = HarnessPlane.rows(
            harnessSessions = listOf(
                summary("claude-code:old", updatedAt = "2026-08-01T00:00:00.000Z"),
                summary("claude-code:new", updatedAt = "2026-08-09T00:00:00.000Z"),
                summary("claude-code:junk", updatedAt = "never"),
            ),
            legacySessions = emptyList(),
        )
        assertEquals(listOf("new", "old", "junk"), rows.map { it.key })
    }

    @Test
    fun `a plane row with no timestamp inherits the legacy row's`() {
        val rows = HarnessPlane.rows(
            harnessSessions = listOf(summary("claude-code:aaa", updatedAt = null)),
            legacySessions = listOf(legacy("aaa", updated = 4242L)),
        )
        assertEquals(4242L, rows.single().updatedAt)
    }

    // ---- capability gate -----------------------------------------------------

    @Test
    fun `the gate mirrors the driver's flags`() {
        val row = HarnessPlane.rows(listOf(summary("claude-code:aaa")), emptyList()).single()
        val gate = HarnessPlane.gate(row, descriptors("claude-code" to fullCaps))
        assertTrue(gate.bound)
        assertTrue(gate.stream)
        assertTrue(gate.canInterrupt)
        assertTrue(gate.canResume)
        // claude-code reports approvals:false, so no approval UI ever renders.
        assertFalse(gate.canApprove)
    }

    @Test
    fun `no stream keeps the row bound for send but off the socket`() {
        val row = HarnessPlane.rows(listOf(summary("grok-build:aaa")), emptyList()).single()
        val gate = HarnessPlane.gate(
            row,
            descriptors("grok-build" to fullCaps.copy(liveStream = false)),
        )
        assertTrue(gate.bound)
        assertFalse(gate.stream)
    }

    @Test
    fun `a legacy row and an unregistered harness are both closed`() {
        val legacyRow = HarnessPlane.rows(emptyList(), listOf(legacy("bbb"))).single()
        assertEquals(HarnessGate.CLOSED, HarnessPlane.gate(legacyRow, descriptors("claude-code" to fullCaps)))

        val orphan = HarnessPlane.rows(listOf(summary("hermes:ccc")), emptyList()).single()
        assertEquals(HarnessGate.CLOSED, HarnessPlane.gate(orphan, descriptors("claude-code" to fullCaps)))

        assertEquals(HarnessGate.CLOSED, HarnessPlane.gate(null, descriptors("claude-code" to fullCaps)))
        assertEquals(HarnessGate.CLOSED, HarnessPlane.gate(orphan, null))
    }

    @Test
    fun `only listSessions-capable harnesses are asked for sessions`() {
        val ds = descriptors(
            "claude-code" to fullCaps,
            "hermes" to fullCaps.copy(listSessions = false),
        )
        assertEquals(listOf("claude-code"), HarnessPlane.listable(ds))
        assertEquals(emptyList<String>(), HarnessPlane.listable(null))
    }

    // ---- error → behavior ----------------------------------------------------

    @Test
    fun `turn_in_flight is matched on the typed code, not the status alone`() {
        assertTrue(
            HarnessPlane.isTurnInFlight(
                HarnessHttpException(409, "turn_in_flight", "busy", null),
            ),
        )
        // 409 also carries session_id_collision, which is NOT a retry.
        assertFalse(
            HarnessPlane.isTurnInFlight(
                HarnessHttpException(409, "session_id_collision", "taken", null),
            ),
        )
        assertFalse(HarnessPlane.isTurnInFlight(HarnessHttpException(409, null, "busy", null)))
        assertFalse(HarnessPlane.isTurnInFlight(RuntimeException("boom")))
        assertFalse(HarnessPlane.isTurnInFlight(null))
    }

    @Test
    fun `gone, malformed and unsupported are fatal - everything else retries`() {
        assertTrue(HarnessPlane.isFatal(HarnessHttpException(404, null, "gone", null)))
        assertTrue(HarnessPlane.isFatal(HarnessHttpException(400, "invalid_session_id", "bad", null)))
        assertTrue(HarnessPlane.isFatal(HarnessHttpException(501, "capability_unsupported", "no", null)))
        // A node restarting or unreachable must not kill the attachment.
        assertFalse(HarnessPlane.isFatal(HarnessHttpException(503, null, "restarting", true)))
        assertFalse(HarnessPlane.isFatal(HarnessHttpException(0, null, "node unreachable", true)))
        assertFalse(HarnessPlane.isFatal(RuntimeException("boom")))
    }

    // ---- registry stream → session list merge --------------------------------

    @Test
    fun `mergeSessionCreated inserts a row without a refetch`() {
        val created = summary("claude-code:bbb", title = "brand new", status = HarnessStatus.ACTIVE)
        assertEquals(listOf(created), HarnessPlane.mergeSessionCreated(emptyList(), created))

        val existing = listOf(summary("claude-code:aaa"))
        val merged = HarnessPlane.mergeSessionCreated(existing, created)
        assertEquals(listOf(created, existing[0]), merged)
        // pure: the prior list is untouched
        assertEquals(1, existing.size)
    }

    @Test
    fun `a merged row is the same shape as a fetched one`() {
        val fetched = summary("claude-code:aaa", title = "from list")
        val fromEvent = summary("claude-code:bbb", title = "from event", status = HarnessStatus.ACTIVE)

        val merged = HarnessPlane.rows(
            HarnessPlane.mergeSessionCreated(listOf(fetched), fromEvent),
            emptyList(),
        )
        // The row a GET returning both would have produced, byte for byte.
        val refetched = HarnessPlane.rows(listOf(fromEvent, fetched), emptyList())
        assertEquals(refetched, merged)

        val row = merged.single { it.key == "bbb" }
        assertEquals(ChatRowKind.HARNESS, row.kind)
        assertEquals("claude-code:bbb", row.sessionId)
        assertEquals("claude-code", row.harnessId)
        assertEquals(HarnessStatus.ACTIVE, row.status)
        // and the gate opens for it exactly as for a fetched row
        assertTrue(HarnessPlane.gate(row, descriptors("claude-code" to fullCaps)).bound)
    }

    @Test
    fun `a session-created that races a refetch leaves one row, not two`() {
        val created = summary("claude-code:aaa", title = "v1", status = HarnessStatus.ACTIVE)
        val once = HarnessPlane.mergeSessionCreated(emptyList(), created)
        // the same frame twice, or a merge onto a refetch that already has it
        val twice = HarnessPlane.mergeSessionCreated(once, created)
        assertEquals(1, twice.size)
        // nothing moved, so the caller can skip the cache write entirely
        assertSame(once, twice)

        // the refetch answered with a staler copy; a later frame wins in place
        val fromRefetch = listOf(
            summary("claude-code:aaa", title = "from GET", status = HarnessStatus.IDLE),
            summary("claude-code:bbb"),
        )
        val after = HarnessPlane.mergeSessionCreated(
            fromRefetch,
            summary("claude-code:aaa", title = "from event", status = HarnessStatus.ACTIVE),
        )
        assertEquals(2, after.size)
        val row = after.single { it.sessionId == "claude-code:aaa" }
        assertEquals("from event", row.title)
        assertEquals(HarnessStatus.ACTIVE, row.status)
    }

    @Test
    fun `session-updated patches status in place`() {
        val list = listOf(summary("claude-code:aaa"), summary("claude-code:bbb"))

        val patched = HarnessPlane.patchSessionUpdated(
            list,
            sessionId = "claude-code:aaa",
            previousSessionId = null,
            status = HarnessStatus.ACTIVE,
        )

        assertEquals(2, patched.size)
        assertEquals(HarnessStatus.ACTIVE, patched.single { it.sessionId == "claude-code:aaa" }.status)
        assertEquals(HarnessStatus.IDLE, patched.single { it.sessionId == "claude-code:bbb" }.status)
        // the rest of the summary is carried, not rebuilt from the frame
        assertEquals(list[0].updatedAt, patched[0].updatedAt)
    }

    @Test
    fun `a rotation rewrites the id, keeps one row, and re-keys the drawer`() {
        val rotated = HarnessPlane.patchSessionUpdated(
            listOf(summary("claude-code:old", title = "kept"), summary("claude-code:other")),
            sessionId = "claude-code:new",
            previousSessionId = "claude-code:old",
            status = HarnessStatus.IDLE,
        )

        val moved = rotated.single { it.sessionId == "claude-code:new" }
        assertEquals("kept", moved.title)
        assertEquals("claude-code", moved.harnessId)
        assertTrue(rotated.none { it.sessionId == "claude-code:old" })
        // the drawer key is the bare native id, so it follows the rotation
        assertEquals("new", HarnessPlane.rows(rotated, emptyList()).first { it.title == "kept" }.key)

        // a create under the new id that raced the rotation collapses into it
        val raced = HarnessPlane.patchSessionUpdated(
            listOf(summary("claude-code:old"), summary("claude-code:new", title = "raced")),
            sessionId = "claude-code:new",
            previousSessionId = "claude-code:old",
            status = HarnessStatus.ACTIVE,
        )
        assertEquals(1, raced.count { it.sessionId == "claude-code:new" })
        assertTrue(raced.none { it.sessionId == "claude-code:old" })
    }

    @Test
    fun `an id nobody has is left for the refetch to reconcile`() {
        val list = listOf(summary("claude-code:aaa"))

        val untouched = HarnessPlane.patchSessionUpdated(
            list,
            sessionId = "claude-code:ccc",
            previousSessionId = null,
            status = HarnessStatus.ENDED,
        )

        // same reference: no row invented, no cache write, no repaint
        assertSame(list, untouched)
    }

    @Test
    fun `applyRegistryEvent covers create and update and ignores everything else`() {
        val created = summary("claude-code:aaa", title = "live")
        val seeded = HarnessPlane.applyRegistryEvent(
            emptyList(),
            HarnessEvent.SessionCreated("claude-code:aaa", created),
        )
        assertEquals(listOf(created), seeded)

        val active = HarnessPlane.applyRegistryEvent(
            seeded,
            HarnessEvent.SessionUpdated("claude-code:aaa", null, HarnessStatus.ACTIVE),
        )
        assertEquals(HarnessStatus.ACTIVE, active.single().status)

        // turn frames are not registry-list events
        assertSame(
            active,
            HarnessPlane.applyRegistryEvent(active, HarnessEvent.TurnComplete("claude-code:aaa", null)),
        )
        assertSame(
            active,
            HarnessPlane.applyRegistryEvent(active, HarnessEvent.AssistantDelta("claude-code:aaa", "hi")),
        )
        // a malformed session-created carries no summary — nothing to merge
        assertSame(
            active,
            HarnessPlane.applyRegistryEvent(active, HarnessEvent.SessionCreated("claude-code:aaa", null)),
        )
    }

    @Test
    fun `iso timestamps become epoch millis`() {
        assertEquals(0L, HarnessPlane.parseIsoMillis("1970-01-01T00:00:00.000Z"))
        assertNull(HarnessPlane.parseIsoMillis(null))
        assertNull(HarnessPlane.parseIsoMillis(""))
        assertNull(HarnessPlane.parseIsoMillis("yesterday"))
    }
}

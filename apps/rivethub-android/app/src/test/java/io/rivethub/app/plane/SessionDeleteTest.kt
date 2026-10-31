package io.rivethub.app.plane

import io.rivethub.app.gateway.SessionDeleteResult
import io.rivethub.app.gateway.SessionTrashCandidate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionDeleteTest {
    private val sid = "claude-code:00000000-0000-4000-8000-000000000001"
    private val native = "00000000-0000-4000-8000-000000000001"

    private fun harnessRow(key: String = sid, pin: Boolean = false) =
        ChatItem(key = key, kind = ChatItemKind.HARNESS, title = "t", sessionId = key, harnessId = "claude-code", pin = pin)

    @Test fun `a harness row deletes by its canonical id`() {
        assertEquals(sid, deleteTargetFor(harnessRow(), emptyList()))
    }

    @Test fun `drafts and agent pointer rows offer no delete`() {
        val draft = ChatItem(key = "abc", kind = ChatItemKind.DRAFT, title = "new conversation")
        assertNull(deleteTargetFor(draft, emptyList()))
        assertNull(deleteTargetFor(harnessRow(key = "bare-draft-id", pin = true), emptyList()))
        assertNull(deleteTargetFor(harnessRow(pin = true), emptyList()))
    }

    @Test fun `a harness row whose id has no known harness prefix offers no delete`() {
        assertNull(deleteTargetFor(harnessRow(key = "mystery:123"), emptyList()))
    }

    @Test fun `a legacy row maps through its roster command`() {
        val legacy = ChatItem(key = native, kind = ChatItemKind.LEGACY, title = "t", command = "claude")
        assertEquals(sid, deleteTargetFor(legacy, emptyList()))
        val shell = ChatItem(key = native, kind = ChatItemKind.LEGACY, title = "t", command = "shell")
        assertNull(deleteTargetFor(shell, emptyList()))
    }

    @Test fun `local keys cover canonical and native`() {
        assertEquals(setOf(sid, native), localKeysFor(sid))
    }

    @Test fun `quoted list names three then the rest`() {
        val more: (Int) -> String = { "and $it more" }
        assertEquals("“a”", quotedList(listOf("a"), more))
        assertEquals("“a”, “b”, “c”", quotedList(listOf("a", "b", "c"), more))
        assertEquals("“a”, “b”, “c” and 2 more", quotedList(listOf("a", "b", "c", "d", "e"), more))
    }

    @Test fun `fold keeps per-item failures and treats a missing result as failed`() {
        val out = foldDeleteResults(
            listOf("a", "b", "c", "d"),
            listOf(
                SessionDeleteResult("a", ok = true, conversations = 1),
                SessionDeleteResult("b", ok = false, error = "session is live"),
                SessionDeleteResult("c", ok = false, error = "not found"),
            ),
        )
        assertEquals(listOf("a"), out.deleted)
        assertEquals(
            listOf(DeleteFailure.Live, DeleteFailure.NotFound, DeleteFailure.Error),
            out.failed.map { it.kind },
        )
        assertEquals("no result from the gateway", out.failed.last().message)
    }

    @Test fun `failure kinds`() {
        assertEquals(DeleteFailure.Live, failureKind("session is live"))
        assertEquals(DeleteFailure.NotFound, failureKind("not found"))
        assertEquals(DeleteFailure.Error, failureKind("delete failed"))
        assertEquals(DeleteFailure.Error, failureKind(null))
    }

    @Test fun `review drops renamed, open and malformed candidates`() {
        fun cand(id: String) = SessionTrashCandidate(session = id, harness = "claude-code", reason = "empty")
        val other = "codex:019a-0000"
        val renamedNative = "claude-code:renamed-native"
        val list = listOf(cand(sid), cand(other), cand(renamedNative), cand(""), cand("nope"))
        val names = setOf("renamed-native")
        assertEquals(
            listOf(other),
            reviewableCandidates(list, { it in names }, exclude = setOf(native)).map { it.session },
        )
    }

    @Test fun `age labels`() {
        val now = java.time.Instant.parse("2026-10-30T12:00:00Z").toEpochMilli()
        assertEquals("5m", ageLabel("2026-10-30T11:55:00Z", now))
        assertEquals("3h", ageLabel("2026-10-30T09:00:00Z", now))
        assertEquals("3d", ageLabel("2026-10-27T12:00:00Z", now))
        assertEquals("3w", ageLabel("2026-10-09T12:00:00Z", now))
        assertEquals("", ageLabel("garbage", now))
    }
}

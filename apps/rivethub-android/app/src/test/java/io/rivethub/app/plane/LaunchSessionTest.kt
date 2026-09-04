package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors rivethub-web lib/launch-session.test.ts case for case. */
class LaunchSessionTest {
    private val hub = "https://a"
    private val other = "https://b"

    private fun row(
        key: String,
        updatedAt: Long,
        kind: ChatItemKind = ChatItemKind.HARNESS,
        pinNodeBaseUrl: String? = null,
        pin: Boolean = false,
    ) = LaunchCandidate(key, updatedAt, kind, pinNodeBaseUrl, pin)

    @Test
    fun `picks the most recent session for the current node`() {
        assertEquals(
            "new",
            pickLaunchSession(listOf(row("old", 100), row("new", 300), row("mid", 200)), hub),
        )
    }

    @Test
    fun `an in-progress draft wins over a more recent finished thread`() {
        assertEquals(
            "draft-1",
            pickLaunchSession(listOf(row("finished", 900), row("draft-1", 100, ChatItemKind.DRAFT)), hub),
        )
    }

    @Test
    fun `picks the most recent draft when several are in progress`() {
        assertEquals(
            "d2",
            pickLaunchSession(
                listOf(row("d1", 100, ChatItemKind.DRAFT), row("finished", 900), row("d2", 200, ChatItemKind.DRAFT)),
                hub,
            ),
        )
    }

    @Test
    fun `prefers the current node over a more recent session on another node`() {
        assertEquals(
            "local",
            pickLaunchSession(
                listOf(row("remote-newer", 900, pinNodeBaseUrl = other), row("local", 100, pinNodeBaseUrl = hub)),
                hub,
            ),
        )
    }

    @Test
    fun `falls back to the most recent session on ANY node when the current node has none`() {
        // The current node (hub) has no sessions → resume the genuinely most
        // recent thread rather than stranding on the list. (This is the
        // datahub case: the default node holds no interactive sessions.)
        assertEquals(
            "remote-new",
            pickLaunchSession(
                listOf(row("remote-old", 100, pinNodeBaseUrl = other), row("remote-new", 500, pinNodeBaseUrl = other)),
                hub,
            ),
        )
    }

    @Test
    fun `excludes agent-pin pointer rows, even the most recent`() {
        // Pin rows are agent pointers, not resumable sessions.
        assertEquals(
            "real",
            pickLaunchSession(
                listOf(row("agent-pin", 900, pinNodeBaseUrl = hub, pin = true), row("real", 100, pinNodeBaseUrl = hub)),
                hub,
            ),
        )
    }

    @Test
    fun `returns null only when there is no resumable session anywhere`() {
        assertNull(pickLaunchSession(emptyList(), hub))
        // All candidates are agent pins → nothing to resume → null → new draft.
        assertNull(
            pickLaunchSession(
                listOf(row("p1", 900, pinNodeBaseUrl = hub, pin = true), row("p2", 800, pinNodeBaseUrl = other, pin = true)),
                hub,
            ),
        )
    }
}

/** Mirrors rivethub-web lib/launch-session.test.ts narrowLaunchTarget cases. */
class NarrowLaunchTargetTest {
    private val hub = "https://a"
    private val items = listOf(
        LaunchCandidate("old", 100, ChatItemKind.HARNESS),
        LaunchCandidate("new", 300, ChatItemKind.HARNESS),
    )

    @Test
    fun `resumes the persisted last session immediately, before the load lands`() {
        assertEquals(
            NarrowLaunchTarget.Resume("last"),
            narrowLaunchTarget("last", loaded = false, sourceKeys = emptySet(), items, hub),
        )
    }

    @Test
    fun `keeps the resume when the load confirms the key still exists`() {
        assertEquals(
            NarrowLaunchTarget.Resume("old"),
            narrowLaunchTarget("old", loaded = true, sourceKeys = setOf("old", "new"), items, hub),
        )
    }

    @Test
    fun `a stale lastActive (no source row after load) falls back to the pick`() {
        assertEquals(
            NarrowLaunchTarget.Pick("new"),
            narrowLaunchTarget("gone", loaded = true, sourceKeys = setOf("old", "new"), items, hub),
        )
    }

    @Test
    fun `a stale lastActive with no sessions anywhere resolves to new`() {
        assertEquals(
            NarrowLaunchTarget.New,
            narrowLaunchTarget("gone", loaded = true, sourceKeys = emptySet(), items = emptyList(), hub),
        )
    }

    @Test
    fun `with nothing persisted and the load in flight, the surface is loading`() {
        assertEquals(
            NarrowLaunchTarget.Loading,
            narrowLaunchTarget(null, loaded = false, sourceKeys = emptySet(), items = emptyList(), hub),
        )
    }

    @Test
    fun `with nothing persisted, the most recent session is picked once loaded`() {
        assertEquals(
            NarrowLaunchTarget.Pick("new"),
            narrowLaunchTarget(null, loaded = true, sourceKeys = setOf("old", "new"), items, hub),
        )
    }

    @Test
    fun `an empty account resolves to the new-conversation compose state, never the list`() {
        assertEquals(
            NarrowLaunchTarget.New,
            narrowLaunchTarget(null, loaded = true, sourceKeys = emptySet(), items = emptyList(), hub),
        )
    }
}

class LastSessionPersistenceTest {
    @Test
    fun `opening a real session persists the resume pointer with a trimmed node url`() {
        assertEquals(
            LastSession("claude-code:abc", "https://a"),
            persistableLastSession("claude-code:abc", "https://a/", draft = false),
        )
    }

    @Test
    fun `drafts are never persisted — they are in-memory only and would resurrect dead`() {
        assertNull(persistableLastSession("3f6b3e1a-0000-4000-8000-000000000000", "https://a", draft = true))
    }

    @Test
    fun `a resumed session is stale only when its node is online and the key is gone`() {
        assertTrue(resumedSessionStale("k", nodeOnline = true, sourceKeys = emptySet()))
        assertFalse(resumedSessionStale("k", nodeOnline = true, sourceKeys = setOf("k")))
        // An unreachable node cannot judge — the session screen keeps its own offline state.
        assertFalse(resumedSessionStale("k", nodeOnline = false, sourceKeys = emptySet()))
    }
}

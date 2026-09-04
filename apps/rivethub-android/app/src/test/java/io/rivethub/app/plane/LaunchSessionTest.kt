package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

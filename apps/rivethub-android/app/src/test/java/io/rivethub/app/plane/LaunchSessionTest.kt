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
    ) = LaunchCandidate(key, updatedAt, kind, pinNodeBaseUrl)

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
    fun `ignores rows pinned from another node`() {
        assertEquals(
            "local",
            pickLaunchSession(listOf(row("remote-pin", 900, ChatItemKind.LEGACY, other), row("local", 100)), hub),
        )
    }

    @Test
    fun `accepts a pin whose node is the current node`() {
        assertEquals(
            "home-pin",
            pickLaunchSession(listOf(row("home-pin", 900, ChatItemKind.LEGACY, hub), row("local", 100)), hub),
        )
    }

    @Test
    fun `returns null when the node has no sessions at all`() {
        assertNull(pickLaunchSession(emptyList(), hub))
        assertNull(pickLaunchSession(listOf(row("remote-pin", 1, ChatItemKind.LEGACY, other)), hub))
    }
}

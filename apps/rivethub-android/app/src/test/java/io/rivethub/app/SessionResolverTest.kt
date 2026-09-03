package io.rivethub.app

import io.rivethub.app.data.SessionResolver
import io.rivethub.app.gateway.DenSessionInfo
import io.rivethub.app.gateway.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionResolverTest {
    private val older = SessionSummary("old", lastActive = 10, messages = 2)
    private val newer = SessionSummary("new", lastActive = 99, messages = 8)
    private val alsoNew = SessionSummary("aaa", lastActive = 99, messages = 1)

    @Test fun `override wins over a newer node session`() {
        assertEquals("mine", SessionResolver.pick("mine", listOf(newer, older), "minted"))
        assertEquals("mine", SessionResolver.adopt("  mine  ", listOf(newer), "minted").id)
        assertFalse(SessionResolver.adopt("mine", listOf(newer), "minted").persist)
    }

    @Test fun `blank override adopts most recently active`() {
        val sessions = listOf(older, newer)
        assertEquals("new", SessionResolver.pick(null, sessions, "minted"))
        assertEquals("new", SessionResolver.pick("  ", sessions, "minted"))
        val pick = SessionResolver.adopt(null, sessions, "minted")
        assertEquals("new", pick.id)
        assertTrue(pick.persist)
    }

    @Test fun `equal lastActive is ordered by id`() {
        // same lastActive → lowest id wins, matching merge's first row
        assertEquals("aaa", SessionResolver.mostRecent(listOf(alsoNew, newer))!!.id)
        assertEquals("aaa", SessionResolver.merge(listOf(alsoNew, newer)).first().id)
    }

    @Test fun `empty node list falls back to minted and persists`() {
        val pick = SessionResolver.adopt(null, emptyList(), "minted")
        assertEquals("minted", pick.id)
        assertTrue(pick.persist)
        assertEquals("minted", SessionResolver.pick(null, emptyList(), "minted"))
    }

    @Test fun `failed fetch does not persist minted`() {
        val pick = SessionResolver.adopt(null, null, "minted")
        assertEquals("minted", pick.id)
        assertFalse(pick.persist)
    }

    @Test fun `merge sorts lastActive desc and overlays den names`() {
        val api = listOf(
            SessionSummary("s-old", lastActive = 1, messages = 3),
            SessionSummary("s-new", lastActive = 50, messages = 1),
            SessionSummary("", lastActive = 99, messages = 9),
        )
        val den = listOf(
            DenSessionInfo("s-new", name = "Alpha", lastEventTs = 9_000),
            DenSessionInfo("s-old", name = "s-old"),
            DenSessionInfo("den-only", name = "Ghost"),
        )
        val rows = SessionResolver.merge(api, den)
        assertEquals(listOf("s-new", "s-old"), rows.map { it.id })
        assertEquals("Alpha", rows[0].name)
        assertEquals("", rows[1].name)
        assertEquals(1, rows[0].messages)
        assertEquals(3, rows[1].messages)
    }

    @Test fun `all-blank ids mint and persist`() {
        val blanks = listOf(SessionSummary(""), SessionSummary("  ", lastActive = 99, messages = 4))
        assertEquals(null, SessionResolver.mostRecent(blanks))
        val pick = SessionResolver.adopt(null, blanks, "minted")
        assertEquals("minted", pick.id)
        assertTrue(pick.persist)
    }

    @Test fun `new session id is default plus stamp plus rand4`() {
        assertEquals(
            "rivetbots-ab-node-claude-20260824-153045-f00d",
            SessionResolver.newSessionId("rivetbots-ab-node-claude", "20260824-153045", "f00d"),
        )
    }
}

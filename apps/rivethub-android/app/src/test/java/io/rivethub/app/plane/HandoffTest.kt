package io.rivethub.app.plane

import io.rivethub.app.gateway.HubLastSession
import io.rivethub.app.gateway.HubState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HandoffTest {
    @Test
    fun `a newer open on desktop wins over the phone's own pointer`() {
        val remote = HubLastSession("arctic::claude-code:desk", 200)
        assertEquals(HandoffTarget("arctic", "claude-code:desk"), handoffTarget(remote, "claude-code:phone", 100))
    }

    @Test
    fun `older, same, draft or missing sessions keep the phone's resume`() {
        assertNull(handoffTarget(HubLastSession("arctic::claude-code:desk", 50), "claude-code:phone", 100))
        assertNull(handoffTarget(HubLastSession("arctic::claude-code:phone", 500), "claude-code:phone", 100))
        assertNull(handoffTarget(HubLastSession("arctic::draftid123", 500), "claude-code:phone", 100))
        assertNull(handoffTarget(null, "claude-code:phone", 100))
        assertNull(handoffTarget(HubLastSession("no-separator", 500), "", 0))
    }

    @Test
    fun `the phone uploads its own last open when the node is known`() {
        val local = LocalHubPrefs(lastSessionKey = "claude-code:a", lastSessionAt = 42)
        assertEquals(
            HubLastSession("arctic::claude-code:a", 42),
            toHubState(local, HubState()) { "arctic" }.lastSession,
        )
        val base = HubState(lastSession = HubLastSession("arctic::codex:b", 7))
        assertEquals(base.lastSession, toHubState(local, base) { null }.lastSession)
    }

    @Test
    fun `last session merges latest-wins, whatever the base`() {
        val older = HubLastSession("pixel::claude-code:a", 10)
        val newer = HubLastSession("arctic::codex:b", 20)
        // the phone still carries its older open; desktop's newer one must survive
        val base = HubState(lastSession = newer)
        assertEquals(newer, mergeHubState(base, HubState(lastSession = older), HubState(lastSession = newer)).lastSession)
        assertEquals(newer, mergeHubState(HubState(), HubState(lastSession = newer), HubState(lastSession = older)).lastSession)
    }
}

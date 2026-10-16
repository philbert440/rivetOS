package io.rivethub.app.plane

import io.rivethub.app.gateway.HubLastSession
import io.rivethub.app.gateway.HubProject
import io.rivethub.app.gateway.HubProjectDefaults
import io.rivethub.app.gateway.HubState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HubStateMergeTest {
    private val k1 = "claude-code:aaa"
    private val k2 = "codex:bbb"
    private val k3 = "claude-code:ccc"
    private val general = HubProject("p1", "General", 0.0, 0)

    @Test
    fun `document keys split on the first separator only`() {
        assertEquals("arctic" to "a::b", splitHubKey(hubKey("arctic", "a::b")))
        assertNull(splitHubKey("::abc"))
        assertNull(splitHubKey("arctic::"))
    }

    @Test
    fun `phone prefs become node keys from the listing, else from the document`() {
        val base = HubState(names = mapOf("pixel::$k2" to "old"))
        val local = LocalHubPrefs(
            names = mapOf(k1 to "Listed", k2 to "Renamed", k3 to "Unknown node"),
            archived = setOf(k1),
            modes = mapOf(k1 to MODE_TERMINAL, k2 to "split"),
        )
        val hub = toHubState(local, base) { if (it == k1) "arctic" else null }
        assertEquals(mapOf("arctic::$k1" to "Listed", "pixel::$k2" to "Renamed"), hub.names)
        assertEquals(listOf("arctic::$k1"), hub.archived)
        assertEquals(mapOf("arctic::$k1" to MODE_TERMINAL), hub.modes)
    }

    @Test
    fun `fields the phone does not edit come from the base document`() {
        val base = HubState(
            projects = listOf(general.copy(defaults = HubProjectDefaults(node = "arctic", directory = "/home/user/x"))),
            defaultProjectId = "p1",
            membership = mapOf("arctic::$k1" to "p1"),
            lastSession = HubLastSession("arctic::$k1", 9),
        )
        val hub = toHubState(LocalHubPrefs(), base) { null }
        assertEquals(base.projects, hub.projects)
        assertEquals(base.membership, hub.membership)
        assertEquals("p1", hub.defaultProjectId)
        assertEquals(base.lastSession, hub.lastSession)
    }

    @Test
    fun `reading the document ignores the node and keeps what was not uploaded`() {
        val hub = HubState(names = mapOf("arctic::$k1" to "From desktop"), archived = listOf("arctic::$k2"))
        val local = LocalHubPrefs(names = mapOf(k3 to "Phone only"), pinned = setOf(k1))
        val mine = HubState(pinned = listOf("arctic::$k1"))
        val next = fromHubState(hub, local, mine)
        assertEquals(mapOf(k3 to "Phone only", k1 to "From desktop"), next.names)
        assertEquals(setOf(k2), next.archived)
        // the pin was uploaded and the merged document dropped it: it goes
        assertEquals(emptySet<String>(), next.pinned)
    }

    @Test
    fun `merge keeps both devices' edits to different entries`() {
        val base = HubState(projects = listOf(general), names = mapOf("a::1" to "one", "a::2" to "two"))
        val local = base.copy(names = mapOf("a::1" to "renamed here", "a::2" to "two"))
        val remote = base.copy(archived = listOf("a::3"), pinned = listOf("a::1"))
        val merged = mergeHubState(base, local, remote)
        assertEquals(mapOf("a::1" to "renamed here", "a::2" to "two"), merged.names)
        assertEquals(listOf("a::3"), merged.archived)
        assertEquals(listOf("a::1"), merged.pinned)
    }

    @Test
    fun `merge applies local removals and drops membership of deleted projects`() {
        val work = HubProject("p2", "Work", 1.0, 1)
        val base = HubState(projects = listOf(general, work), membership = mapOf("a::1" to "p2"), hidden = listOf("a::1"))
        val local = base.copy(hidden = emptyList())
        val remote = base.copy(projects = listOf(general))
        val merged = mergeHubState(base, local, remote)
        assertEquals(listOf(general), merged.projects)
        assertTrue(merged.membership.isEmpty())
        assertTrue(merged.hidden.isEmpty())
    }

    @Test
    fun `merge prefers the later last session when both moved it`() {
        val base = HubState()
        val merged = mergeHubState(
            base,
            base.copy(lastSession = HubLastSession("a::1", 50)),
            base.copy(lastSession = HubLastSession("a::2", 40)),
        )
        assertEquals(HubLastSession("a::1", 50), merged.lastSession)
    }

    @Test
    fun `same ignores the order of key lists`() {
        assertTrue(sameHubState(HubState(archived = listOf("a::1", "a::2")), HubState(archived = listOf("a::2", "a::1"))))
    }
}

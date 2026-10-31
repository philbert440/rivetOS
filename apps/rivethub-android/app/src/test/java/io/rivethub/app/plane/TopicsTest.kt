package io.rivethub.app.plane

import io.rivethub.app.gateway.HubProject
import io.rivethub.app.gateway.TopicSession
import io.rivethub.app.gateway.TopicSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TopicsTest {
    private val sid = "claude-code:00000000-0000-4000-8000-000000000001"
    private val native = "00000000-0000-4000-8000-000000000001"

    private fun topic(id: String, name: String, parent: String? = null, last: Long? = null, closed: Long? = null, kind: String = "work") =
        TopicSummary(id = id, kind = kind, name = name, parent = parent, updatedAt = 1, lastActive = last, closedAt = closed)

    @Test fun `roots go newest first, each followed by its subtopics named by path`() {
        val shown = drawerTopics(
            listOf(
                topic("a", "Android", last = 10),
                topic("b", "Backend", last = 20),
                topic("a1", "Topics", parent = "a", last = 5),
                topic("a1x", "Drawer", parent = "a1", last = 4),
            ),
        )
        assertEquals(listOf("Backend", "Android", "Android › Topics", "Android › Topics › Drawer"), shown.map { it.name })
        assertEquals(listOf(0.0, 1.0, 2.0, 3.0), shown.map { it.order })
    }

    @Test fun `a closed topic hides with its subtree until a session is active after it closed`() {
        val closed = topic("a", "Old", closed = 100, last = 90)
        val child = topic("a1", "Child", parent = "a", last = 200)
        assertTrue(drawerTopics(listOf(closed, child)).isEmpty())
        assertFalse(topicOpen(closed))
        assertTrue(topicOpen(closed.copy(lastActive = 101)))
        assertEquals(listOf("Old", "Old › Child"), drawerTopics(listOf(closed.copy(lastActive = 101), child)).map { it.name })
    }

    @Test fun `types and entities never become drawer sections`() {
        assertTrue(drawerTopics(listOf(topic("t", "People", kind = "type"), topic("e", "Phil", parent = "t", kind = "entity"))).isEmpty())
    }

    @Test fun `membership answers under the canonical and the native id, for known topics only`() {
        val m = topicMembership(
            listOf(TopicSession(sessionId = sid, topicId = "a"), TopicSession(sessionId = "codex:x", topicId = "gone")),
            setOf("a"),
        )
        assertEquals(mapOf(sid to "a", native to "a"), m)
    }

    @Test fun `pending placements wait for a session, drop for gone topics or ones rh already shows`() {
        val pending = mapOf("draft-1" to "a", "k-real" to "a", "k-done" to "a", "k-gone" to "zzz")
        val canonical = mapOf("k-real" to sid, "k-done" to "codex:y", "k-gone" to "codex:z")
        val plan = planPlacements(pending, { canonical[it] }, setOf("a"), placed = mapOf("codex:y" to "a"))
        assertEquals(listOf(PlacementWork("k-real", sid, "a")), plan.send)
        assertEquals(setOf("k-done", "k-gone"), plan.drop)
    }

    @Test fun `projects join a topic of the same name or are created, and their sessions follow`() {
        val projects = listOf(HubProject("p1", "Android", 1.0), HubProject("p2", "November RH", 0.0), HubProject("p3", " ", 2.0))
        val plan = planProjectMigration(projects, listOf(topic("t1", "android"), topic("ty", "November RH", kind = "type")))
        assertEquals(mapOf("p1" to "t1"), plan.reuse)
        assertEquals(listOf("p2"), plan.create.map { it.id })
        val placements = migratedPlacements(mapOf("k1" to "p1", "k2" to "p2", "k3" to "p3"), mapOf("p1" to "t1", "p2" to "t2"))
        assertEquals(mapOf("k1" to "t1", "k2" to "t2"), placements)
    }
}

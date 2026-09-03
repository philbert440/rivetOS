package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NodeSheetTest {
    private val entry = "https://192.0.2.10:5174"
    private val extra = "https://192.0.2.11:5174"
    private val mesh = "https://192.0.2.12:5174"

    private val nodes = listOf(
        NodeSheetInput("ct115", "ct115", entry, sessions = 3),
        NodeSheetInput("ct119", "ct119", extra, sessions = 1),
        NodeSheetInput("peer", "peer", mesh, sessions = 4),
    )

    @Test
    fun `current saved node gets a filled bullet`() {
        val model = buildNodeSheet(entry, setOf(extra), nodes, viewNodeId = "ct115")
        val cur = model.saved.find { it.id == "ct115" }!!
        assertTrue(cur.current)
        assertEquals("●", cur.marker)
        val other = model.saved.find { it.id == "ct119" }!!
        assertFalse(other.current)
        assertEquals("○", other.marker)
    }

    @Test
    fun `entry node is saved and not removable`() {
        val model = buildNodeSheet(entry, emptySet(), nodes, viewNodeId = "")
        val row = model.saved.single { it.denUrl == entry }
        assertTrue(row.saved)
        assertFalse(row.removable)
        assertTrue(row.current)
    }

    @Test
    fun `discovered nodes are the mesh remainder`() {
        val model = buildNodeSheet(entry, setOf(extra), nodes, viewNodeId = "ct115")
        assertEquals(listOf("peer"), model.discovered.map { it.id })
        assertFalse(model.discovered.first().saved)
        assertEquals("+ peer (4 sessions)", discoveredNodeLabel("peer", 4))
        assertEquals("+ peer", discoveredNodeLabel("peer", null))
    }

    @Test
    fun `no saved nodes when entry and extras are blank`() {
        val model = buildNodeSheet("", emptySet(), nodes, viewNodeId = "")
        assertTrue(model.saved.isEmpty())
        assertEquals(3, model.discovered.size)
    }

    @Test
    fun `mesh unavailable flag is passed through`() {
        val model = buildNodeSheet(entry, emptySet(), emptyList(), viewNodeId = "", meshUnavailable = true)
        assertTrue(model.meshUnavailable)
        assertEquals(1, model.saved.size)
    }

    @Test
    fun `node error badge rides on the matching id`() {
        val model = buildNodeSheet(
            entry, emptySet(), nodes, viewNodeId = "ct115",
            nodeErrors = mapOf("ct115" to "timed out"),
        )
        assertEquals("timed out", model.saved.find { it.id == "ct115" }?.error)
    }
}

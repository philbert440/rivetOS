package io.rivethub.app.plane

import io.rivethub.app.gateway.AgentPreset
import io.rivethub.app.gateway.CatalogAgent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentBuildTest {
    private val nodeA = AgentNodeHint("a", "alpha", "https://192.0.2.10:5174", true)
    private val nodeB = AgentNodeHint("b", "beta", "https://192.0.2.11:5174", true)
    private val nodes = listOf(nodeA, nodeB)

    @Test fun `unmatched preset keeps its own URL and is offline`() {
        val pointers = AgentPointers { 1 }
        val ghost = AgentPreset(id = "ghost", name = "Ghost", nodeBaseUrl = "https://192.0.2.99:5174")
        val rows = buildAgents(
            nodes,
            listOf(nodeA.denUrl to Result.success(listOf(ghost))),
            catalog = listOf(CatalogAgent(id = "claude", node = "a")),
            pointers,
        )
        val row = rows.single()
        assertEquals("ghost", row.agentId)
        assertEquals("https://192.0.2.99:5174", row.nodeDenUrl)
        assertEquals("https://192.0.2.99:5174", row.nodeName)
        assertFalse(row.online)
        assertTrue(row.nodeDenUrl != nodeA.denUrl)
    }

    @Test fun `matched preset binds that node not the first healthy`() {
        val pointers = AgentPointers { 1 }
        val grok = AgentPreset(id = "grok", name = "Grok", nodeBaseUrl = nodeB.denUrl, harnessId = "grok-build")
        val rows = buildAgents(
            nodes,
            listOf(nodeA.denUrl to Result.success(listOf(grok))),
            catalog = emptyList(),
            pointers,
        )
        val row = rows.single()
        assertEquals("b", row.nodeId)
        assertEquals(nodeB.denUrl, row.nodeDenUrl)
        assertTrue(row.online)
        assertEquals("grok-build", row.harnessId)
    }

    @Test fun `never binds a preset to an unrelated node by agent id`() {
        val pointers = AgentPointers { 1 }
        val namedLikeNode = AgentPreset(id = "a", name = "Named like node A", nodeBaseUrl = "https://192.0.2.99:5174")
        val row = buildAgents(
            nodes,
            listOf(nodeA.denUrl to Result.success(listOf(namedLikeNode))),
            catalog = emptyList(),
            pointers,
        ).single()
        assertEquals("https://192.0.2.99:5174", row.nodeDenUrl)
        assertFalse(row.online)
        assertEquals("192.0.2.99", row.nodeId)
    }

    @Test fun `union keeps agents from every node and skips a failure`() {
        val pointers = AgentPointers { 1 }
        val claude = AgentPreset(id = "claude", name = "Claude", nodeBaseUrl = nodeA.denUrl)
        val grok = AgentPreset(id = "grok", name = "Grok", nodeBaseUrl = "https://192.0.2.12:5174")
        val rows = buildAgents(
            nodes,
            listOf(
                nodeA.denUrl to Result.success(listOf(claude)),
                nodeB.denUrl to Result.failure<List<AgentPreset>>(RuntimeException("down")),
                "https://192.0.2.12:5174" to Result.success(listOf(grok)),
            ),
            catalog = emptyList(),
            pointers,
        )
        assertEquals(listOf("claude", "grok"), rows.map { it.agentId })
        assertEquals(nodeA.denUrl, rows[0].nodeDenUrl)
        assertEquals("https://192.0.2.12:5174", rows[1].nodeDenUrl)
        assertFalse(rows[1].online)
    }

    @Test fun `empty agents from every node falls back to catalog`() {
        val pointers = AgentPointers { 1 }
        val catalog = listOf(CatalogAgent(id = "claude", node = "a", provider = "claude-cli"))
        val rows = buildAgents(
            nodes,
            listOf(
                nodeA.denUrl to Result.success(emptyList()),
                nodeB.denUrl to Result.success(emptyList()),
            ),
            catalog,
            pointers,
        )
        val row = rows.single()
        assertEquals("claude", row.agentId)
        assertEquals("a", row.nodeId)
        assertEquals("claude-code", row.harnessId)
    }

    @Test fun `non-empty presets do not mix catalog`() {
        val pointers = AgentPointers { 1 }
        val grok = AgentPreset(id = "grok", name = "Grok", nodeBaseUrl = nodeB.denUrl)
        val rows = buildAgents(
            nodes,
            listOf(nodeA.denUrl to Result.success(listOf(grok))),
            catalog = listOf(CatalogAgent(id = "claude", node = "a")),
            pointers,
        )
        assertEquals(listOf("grok"), rows.map { it.agentId })
        assertNull(rows.find { it.agentId == "claude" })
    }
}

package io.rivethub.app.plane

import io.rivethub.app.gateway.AgentPreset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentsTest {
    private val nodeA = AgentNodeHint("a", "alpha", "https://192.0.2.10:5174", true, meshNode = "alpha")
    private val ct112 = AgentNodeHint(
        id = "n112",
        name = "ct112",
        denUrl = "https://192.0.2.12:5174",
        online = true,
        meshNode = "ct112",
    )
    private val ct115 = AgentNodeHint(
        id = "n115",
        name = "CT115",
        denUrl = "https://192.0.2.15:5174",
        online = true,
        meshNode = "ct115",
    )

    @Test fun `preset node name binds that mesh node ahead of nodeBaseUrl`() {
        val reviewer = AgentPreset(
            id = "reviewer",
            name = "reviewer",
            node = "ct115",
            directory = "/srv/agents/reviewer/",
            sharedLink = false,
            nodeBaseUrl = ct112.denUrl,
        )
        val row = buildAgents(
            listOf(ct112, ct115),
            listOf(ct112.denUrl to Result.success(listOf(reviewer))),
            catalog = emptyList(),
            AgentPointers { 1 },
        ).single()
        assertEquals(ct115.denUrl, row.nodeDenUrl)
        assertEquals("n115", row.nodeId)
        assertTrue(row.online)
        assertEquals("ct115", row.node)
        assertEquals("/srv/agents/reviewer/", row.directory)
        assertFalse(row.sharedLink)
        assertEquals("ct115 · reviewer", agentRowSubtitle(row))
    }

    @Test fun `preset node matches hint id or display name ignoring case`() {
        val byId = AgentPreset(id = "by-id", name = "By id", node = "N115")
        val idRow = buildAgents(
            listOf(ct115.copy(meshNode = "")),
            listOf(ct112.denUrl to Result.success(listOf(byId))),
            catalog = emptyList(),
            AgentPointers { 1 },
        ).single()
        assertEquals(ct115.denUrl, idRow.nodeDenUrl)

        val byName = AgentPreset(id = "by-name", name = "By name", node = "ct115")
        val nameRow = buildAgents(
            listOf(ct115.copy(meshNode = "")),
            listOf(ct112.denUrl to Result.success(listOf(byName))),
            catalog = emptyList(),
            AgentPointers { 1 },
        ).single()
        assertEquals(ct115.denUrl, nameRow.nodeDenUrl)
    }

    @Test fun `unmatched node does not fall through to nodeBaseUrl or the serving den`() {
        val viaUrl = AgentPreset(
            id = "via-url",
            name = "Via URL",
            node = "ct999",
            nodeBaseUrl = nodeA.denUrl,
        )
        val urlRow = buildAgents(
            listOf(nodeA, ct115),
            listOf(ct115.denUrl to Result.success(listOf(viaUrl))),
            catalog = emptyList(),
            AgentPointers { 1 },
        ).single()
        assertEquals("", urlRow.nodeDenUrl)
        assertEquals("ct999", urlRow.nodeId)
        assertEquals("ct999", urlRow.nodeName)
        assertFalse(urlRow.online)

        val served = AgentPreset(id = "served", name = "Served", node = "ct999", directory = "/srv/agents/served")
        val servedRow = buildAgents(
            listOf(nodeA, ct115),
            listOf(ct115.denUrl to Result.success(listOf(served))),
            catalog = emptyList(),
            AgentPointers { 1 },
        ).single()
        assertEquals("", servedRow.nodeDenUrl)
        assertEquals("ct999", servedRow.nodeId)
        assertEquals("ct999", servedRow.node)
        assertFalse(servedRow.online)
        assertEquals("ct999 · served", agentRowSubtitle(servedRow))
    }

    @Test fun `unmatched preset node is an offline hint named after that node`() {
        val preset = AgentPreset(id = "served", name = "Served", node = "ct999", directory = "/srv/agents/served")
        assertEquals(
            AgentNodeHint(id = "ct999", name = "ct999", denUrl = "", online = false, meshNode = "ct999"),
            resolvePresetNode(preset, ct115.denUrl, listOf(nodeA, ct115)),
        )
        val row = buildAgents(
            listOf(nodeA, ct115),
            listOf(ct115.denUrl to Result.success(listOf(preset))),
            catalog = emptyList(),
            AgentPointers { 1 },
        ).single()
        assertFalse(row.online)
        assertEquals("", row.nodeDenUrl)
        assertEquals("ct999", row.nodeId)
        assertEquals("ct999 · served", agentRowSubtitle(row))
    }

    @Test fun `an unmatched offline preset cannot produce a chat destination with an empty url`() {
        val preset = AgentPreset(id = "served", name = "Served", node = "ct999", directory = "/srv/agents/served")
        val pointers = AgentPointers { 1 }
        val row = buildAgents(
            listOf(nodeA, ct115),
            listOf(ct115.denUrl to Result.success(listOf(preset))),
            catalog = emptyList(),
            pointers,
        ).single()
        assertFalse(row.online)
        assertEquals("", row.nodeDenUrl)
        assertNull(openAgentRow(row, pointers, AgentAction.Tap) { "draft-tap" })
        assertNull(openAgentRow(row, pointers, AgentAction.Plus) { "draft-plus" })
        assertNull(openAgentRow(row, pointers, AgentAction.Replace) { "draft-replace" })
        assertNull(openAgentRow(row.copy(online = true), pointers, AgentAction.Plus) { "draft-blank" })
        assertNull(pointers.get(preset.id))
        val live = buildAgents(
            listOf(nodeA, ct115),
            listOf(ct115.denUrl to Result.success(listOf(preset.copy(node = "ct115")))),
            catalog = emptyList(),
            pointers,
        ).single()
        val open = openAgentRow(live, pointers, AgentAction.Plus) { "draft-live" }
        assertEquals(ct115.denUrl, open!!.nodeDenUrl)
        assertTrue(open.nodeDenUrl.isNotBlank())
    }

    @Test fun `older den preset without node keeps a blank node and the legacy URL`() {
        val preset = AgentPreset(id = "grok", name = "Grok", nodeBaseUrl = nodeA.denUrl)
        val row = buildAgents(
            listOf(nodeA, ct115),
            listOf(ct115.denUrl to Result.success(listOf(preset))),
            catalog = emptyList(),
            AgentPointers { 1 },
        ).single()
        assertEquals("", row.node)
        assertEquals("", row.directory)
        assertEquals(nodeA.denUrl, row.nodeDenUrl)
        assertEquals("", agentRowSubtitle(row))
    }

    @Test fun `subtitle is node, basename, both, or empty`() {
        val base = AgentRow(
            agentId = "id",
            name = "n",
            harnessId = null,
            nodeId = "nid",
            nodeName = "nname",
            nodeDenUrl = "https://192.0.2.10:5174",
            pointerSessionId = null,
        )
        assertEquals("", agentRowSubtitle(base))
        assertEquals("ct115", agentRowSubtitle(base.copy(node = " ct115 ")))
        assertEquals("reviewer", agentRowSubtitle(base.copy(directory = "/srv/agents/reviewer/")))
        assertEquals(
            "ct115 · reviewer",
            agentRowSubtitle(base.copy(node = "ct115", directory = "/srv/agents/reviewer")),
        )
        assertEquals("", directoryBasename("   "))
        assertEquals("reviewer", directoryBasename("reviewer"))
    }
}

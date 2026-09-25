package io.rivethub.app.plane

import io.rivethub.app.gateway.AgentUpdateRequest
import io.rivethub.app.gateway.EffortOption
import io.rivethub.app.gateway.ModelOption
import io.rivethub.app.gateway.wireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentEditTest {

    private fun originalRow(
        directory: String = "",
        sharedLink: Boolean = true,
    ) = AgentRow(
        agentId = "a",
        name = "rivet",
        harnessId = "claude-code",
        nodeId = "n1",
        nodeName = "n1",
        nodeDenUrl = "https://192.0.2.10:5174",
        pointerSessionId = null,
        directory = directory,
        sharedLink = sharedLink,
    )

    @Test fun `sheet actions are StartOver New Edit GoToNode in order`() {
        assertEquals(
            listOf(
                AgentSheetAction.StartOver,
                AgentSheetAction.New,
                AgentSheetAction.Edit,
                AgentSheetAction.GoToNode,
            ),
            agentSheetActions(),
        )
    }

    @Test fun `offline sheet omits Edit`() {
        assertEquals(
            listOf(
                AgentSheetAction.StartOver,
                AgentSheetAction.New,
                AgentSheetAction.GoToNode,
            ),
            agentSheetActions(online = false),
        )
    }

    @Test fun `patch builder maps every field to the den shape`() {
        val req = agentPatchRequest(
            AgentEditFields(
                name = "  rivet  ",
                color = "#CC785C",
                model = "claude-opus",
                effort = "high",
                systemPrompt = "be terse",
                directory = "  /srv/agents/rivet  ",
                sharedLink = false,
            ),
            originalRow(),
        )
        assertEquals("rivet", req.name)
        assertEquals("#CC785C", req.color)
        assertEquals("claude-opus", req.model)
        assertEquals("high", req.effort)
        assertEquals("be terse", req.systemPrompt)
        assertEquals("/srv/agents/rivet", req.directory)
        assertEquals(false, req.sharedLink)
        assertNull(req.nodeBaseUrl)
    }

    @Test fun `patch builder omits blank fields and they drop out of the JSON`() {
        val req = agentPatchRequest(
            AgentEditFields(name = "rivet", systemPrompt = "   "),
            originalRow(),
        )
        assertEquals("rivet", req.name)
        assertNull(req.color)
        assertNull(req.model)
        assertNull(req.effort)
        assertNull(req.systemPrompt)
        assertNull(req.nodeBaseUrl)
        assertNull(req.directory)
        assertNull(req.sharedLink)
        val json = wireJson.encodeToString(AgentUpdateRequest.serializer(), req)
        assertTrue(json.contains("\"name\":\"rivet\""))
        assertFalse(json.contains("color"))
        assertFalse(json.contains("model"))
        assertFalse(json.contains("effort"))
        assertFalse(json.contains("systemPrompt"))
        assertFalse(json.contains("nodeBaseUrl"))
        assertFalse(json.contains("directory"))
        assertFalse(json.contains("sharedLink"))
        assertFalse(json.contains("harnessId"))
    }

    @Test fun `patch emits directory and sharedLink only when they changed`() {
        val original = originalRow(directory = "/srv/agents/rivet", sharedLink = true)
        val same = agentPatchRequest(
            AgentEditFields(name = "rivet", directory = "  /srv/agents/rivet  ", sharedLink = true),
            original,
        )
        assertNull(same.directory)
        assertNull(same.sharedLink)
        val changed = agentPatchRequest(
            AgentEditFields(name = "rivet", directory = "/srv/other", sharedLink = false),
            original,
        )
        assertEquals("/srv/other", changed.directory)
        assertEquals(false, changed.sharedLink)
        val cleared = agentPatchRequest(
            AgentEditFields(name = "rivet", directory = "   ", sharedLink = true),
            original,
        )
        assertNull(cleared.directory)
        val json = wireJson.encodeToString(AgentUpdateRequest.serializer(), changed)
        assertTrue(json.contains("\"directory\":\"/srv/other\""))
        assertTrue(json.contains("\"sharedLink\":false"))
        assertFalse(json.contains("nodeBaseUrl"))
        val sameJson = wireJson.encodeToString(AgentUpdateRequest.serializer(), same)
        assertFalse(sameJson.contains("directory"))
        assertFalse(sameJson.contains("sharedLink"))
        assertFalse(sameJson.contains("nodeBaseUrl"))
    }

    @Test fun `directory placeholder is root slash slug, else empty`() {
        assertEquals("agent", agentSlug("   "))
        assertEquals("code-review", agentSlug("Code Review"))
        assertEquals("/srv/agents/code-review", agentDirectoryPlaceholder("/srv/agents/", "Code Review"))
        assertEquals("", agentDirectoryPlaceholder("  ", "Code Review"))
        assertEquals("", agentDirectoryPlaceholder(null, "Code Review"))
    }

    @Test fun `go to node returns the node unless it is already viewed`() {
        assertEquals("ct115", agentGoToNodeId("", "ct115"))
        assertEquals("ct115", agentGoToNodeId("ct119", "ct115"))
        assertNull(agentGoToNodeId("ct115", "ct115"))
        assertNull(agentGoToNodeId("", ""))
    }

    @Test fun `model options unshift the current value when unlisted`() {
        val sheet = HarnessSheet(
            models = listOf(
                ModelOption("m1", "Model One", default = true),
                ModelOption("m2", "Model Two"),
            ),
        )
        assertEquals(
            listOf("m1" to "Model One", "m2" to "Model Two"),
            agentModelOptions(sheet, "m2"),
        )
        assertEquals(
            listOf("custom" to "custom", "m1" to "Model One", "m2" to "Model Two"),
            agentModelOptions(sheet, "custom"),
        )
        // Empty sheet: just the current value, so a saved model round-trips.
        assertEquals(listOf("custom" to "custom"), agentModelOptions(null, "custom"))
        assertEquals(emptyList<Pair<String, String>>(), agentModelOptions(null, ""))
    }

    @Test fun `effort options follow the model and unshift the current value`() {
        val sheet = HarnessSheet(
            models = listOf(
                ModelOption(
                    "m1",
                    "Model One",
                    efforts = listOf(EffortOption("low", "Low"), EffortOption("high", "High")),
                ),
            ),
            efforts = listOf(EffortOption("medium", "Medium")),
        )
        // A model's own efforts win over harness-wide efforts.
        assertEquals(
            listOf("low" to "Low", "high" to "High"),
            agentEffortOptions(sheet, "m1", ""),
        )
        assertEquals(
            listOf("medium" to "Medium"),
            agentEffortOptions(sheet, "unknown-model", ""),
        )
        assertEquals(
            listOf("ultra" to "ultra", "low" to "Low", "high" to "High"),
            agentEffortOptions(sheet, "m1", "ultra"),
        )
    }

    @Test fun `color gate accepts empty and hex, rejects garbage`() {
        assertTrue(agentColorValid(""))
        assertTrue(agentColorValid("#fff"))
        assertTrue(agentColorValid("#CC785C"))
        assertFalse(agentColorValid("red"))
        assertFalse(agentColorValid("#1234"))
        assertFalse(agentColorValid("#ggg"))
    }
}

package io.rivethub.app

import io.rivethub.app.gateway.AgentPreset
import io.rivethub.app.gateway.AgentsListResponse
import io.rivethub.app.gateway.CatalogAgent
import io.rivethub.app.gateway.CatalogAgentsResponse
import io.rivethub.app.gateway.DenFrame
import io.rivethub.app.gateway.Healthz
import io.rivethub.app.gateway.MeshOverview
import io.rivethub.app.gateway.SessionFrame
import io.rivethub.app.gateway.TermSpawnRequest
import io.rivethub.app.gateway.TermSpawnResponse
import io.rivethub.app.gateway.isPreset
import io.rivethub.app.gateway.parseDenFrame
import io.rivethub.app.gateway.parseSessionFrame
import io.rivethub.app.gateway.wireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WireTest {
    @Test fun `message frame is flattened with kind`() {
        val f = parseSessionFrame("""{"kind":"message","id":"m1","sessionId":"s1","role":"assistant","text":"hi","ts":5,"tools":[{"name":"Bash","status":"done"}]}""")
        val m = (f as SessionFrame.Message).message
        assertEquals("m1", m.id); assertEquals("s1", m.sessionId); assertEquals("Bash", m.tools!!.single().name)
    }

    @Test fun `stream frame carries session and event`() {
        val f = parseSessionFrame("""{"kind":"stream","session":"s1","event":{"type":"text","content":"PO","metadata":{"x":1}}}""")
        val s = f as SessionFrame.Stream
        assertEquals("s1", s.session); assertEquals("text", s.type); assertEquals("PO", s.content); assertEquals("1", s.metadata!!["x"].toString())
    }

    @Test fun `unknown kinds and junk do not throw`() {
        assertTrue(parseSessionFrame("""{"kind":"transcript","x":1}""") is SessionFrame.Other)
        assertTrue(parseSessionFrame("""{"kind":"sessions-dirty"}""") is SessionFrame.SessionsDirty)
        assertNull(parseSessionFrame("not json"))
        assertNull(parseSessionFrame("""{"nokind":true}"""))
    }

    @Test fun `den snapshot decodes rooms and tolerates extra fields`() {
        val f = parseDenFrame("""{"type":"snapshot","v":1,"sessions":[{"id":"s1","name":"S"}],"rooms":{"s1":{"title":"T","activity":"editing_code","tool":"Edit","tasks":[{"label":"a","done":true}],"thought":"","lastMessage":"","log":[],"term":["$ ls"],"ended":false,"future":1}}}""")
        val snap = f as DenFrame.Snapshot
        assertEquals("editing_code", snap.rooms["s1"]!!.activity); assertEquals(listOf("$ ls"), snap.rooms["s1"]!!.term)
        assertEquals("S", snap.sessions.single().name)
        val ev = parseDenFrame("""{"type":"tool.start","v":1,"session":"s1","tool":"Bash"}""") as DenFrame.Event
        assertEquals("s1", ev.session)
    }

    @Test fun `mesh and catalog shapes match the live gateway`() {
        val mesh = wireJson.decodeFromString(MeshOverview.serializer(), """{"updatedAt":1,"nodes":[{"id":"n1","name":"n1","denUrl":"https://192.0.2.10:5174","online":true,"sessions":null}]}""")
        assertEquals(true, mesh.nodes.single().online); assertNull(mesh.nodes.single().sessions)
        val cat = wireJson.decodeFromString(CatalogAgentsResponse.serializer(), """{"agents":[{"id":"claude","provider":"claude-cli","node":"n1","local":true},{"id":"kimi","node":"n2","local":false}]}""")
        assertEquals(2, cat.agents.size); assertNull(cat.agents[1].provider)
    }

    @Test fun `agent preset and term inject shapes match the gateway`() {
        val agents = wireJson.decodeFromString(
            io.rivethub.app.gateway.AgentsListResponse.serializer(),
            """{"agents":[{"id":"a1","name":"Claude","color":"#3b82f6","harnessId":"claude-code","model":"opus","effort":"high","systemPrompt":"","nodeBaseUrl":"https://192.0.2.10:5174","createdAt":1,"updatedAt":2}]}""",
        )
        assertEquals("Claude", agents.agents.single().name)
        assertEquals("claude-code", agents.agents.single().harnessId)
        val inj = wireJson.decodeFromString(
            io.rivethub.app.gateway.TermInjectRequest.serializer(),
            """{"session":"draft-1","text":"hi"}""",
        )
        assertEquals("draft-1", inj.session)
        assertEquals("hi", inj.text)
        assertNull(inj.submit)
        val encoded = wireJson.encodeToString(
            io.rivethub.app.gateway.TermInjectRequest.serializer(),
            io.rivethub.app.gateway.TermInjectRequest("s", "hello", interrupt = true),
        )
        assertTrue(encoded.contains("\"interrupt\":true"))
        assertTrue(!encoded.contains("\\r"))
    }

    @Test fun `healthz node decodes and defaults to empty`() {
        val live = wireJson.decodeFromString(Healthz.serializer(), """{"ok":true,"sessions":1,"name":"den","node":"ct115"}""")
        assertEquals("ct115", live.node)
        assertTrue(live.ok)
        val old = wireJson.decodeFromString(Healthz.serializer(), """{"ok":true,"sessions":2,"name":"den"}""")
        assertEquals("", old.node)
        assertEquals(2, old.sessions)
    }

    @Test fun `agent preset decodes node directory sharedLink and list meta`() {
        val agents = wireJson.decodeFromString(
            AgentsListResponse.serializer(),
            """{"agents":[{"id":"reviewer","name":"reviewer","node":"ct115","directory":"/srv/agents/reviewer","sharedLink":false,"nodeBaseUrl":"https://192.0.2.15:5174"}],"node":"ct115","directoryRoot":"/srv/agents","sharedDir":"/srv/shared","backend":"postgres"}""",
        )
        val preset = agents.agents.single()
        assertEquals("ct115", preset.node)
        assertEquals("/srv/agents/reviewer", preset.directory)
        assertEquals(false, preset.sharedLink)
        assertEquals("https://192.0.2.15:5174", preset.nodeBaseUrl)
        assertEquals("ct115", agents.node)
        assertEquals("/srv/agents", agents.directoryRoot)
        assertEquals("/srv/shared", agents.sharedDir)
        assertEquals("postgres", agents.backend)
        val bare = wireJson.decodeFromString(AgentPreset.serializer(), """{"id":"old"}""")
        assertEquals("", bare.node)
        assertEquals("", bare.directory)
        assertEquals(true, bare.sharedLink)
    }

    @Test fun `catalog preset kind carries implemented and gap`() {
        val cat = wireJson.decodeFromString(
            CatalogAgentsResponse.serializer(),
            """{"agents":[{"kind":"preset","id":"reviewer","name":"reviewer","node":"ct115","local":false,"harnessId":"claude-code","directory":"/srv/agents/reviewer","implemented":false,"gap":"no pty"}]}""",
        )
        val agent = cat.agents.single()
        assertTrue(agent.isPreset)
        assertEquals("reviewer", agent.name)
        assertEquals("claude-code", agent.harnessId)
        assertEquals("/srv/agents/reviewer", agent.directory)
        assertEquals(false, agent.implemented)
        assertEquals("no pty", agent.gap)
        val local = CatalogAgent(id = "claude", node = "n1", local = true)
        assertFalse(local.isPreset)
        assertNull(local.kind)
    }

    @Test fun `term spawn response carries cwd and the request encodes agentId and force`() {
        val spawned = wireJson.decodeFromString(
            TermSpawnResponse.serializer(),
            """{"id":"pty-1","cwd":"/srv/agents/reviewer"}""",
        )
        assertEquals("/srv/agents/reviewer", spawned.cwd)
        val old = wireJson.decodeFromString(TermSpawnResponse.serializer(), """{"id":"pty-2"}""")
        assertNull(old.cwd)
        val body = wireJson.encodeToString(
            TermSpawnRequest.serializer(),
            TermSpawnRequest(session = "s1", agentId = "reviewer", force = true),
        )
        assertTrue(body.contains("\"agentId\":\"reviewer\""))
        assertTrue(body.contains("\"force\":true"))
        val plain = wireJson.encodeToString(
            TermSpawnRequest.serializer(),
            TermSpawnRequest(session = "s1"),
        )
        assertFalse(plain.contains("agentId"))
        assertFalse(plain.contains("force"))
    }
}

package io.rivethub.app

import io.rivethub.app.gateway.CatalogAgentsResponse
import io.rivethub.app.gateway.DenFrame
import io.rivethub.app.gateway.MeshOverview
import io.rivethub.app.gateway.SessionFrame
import io.rivethub.app.gateway.parseDenFrame
import io.rivethub.app.gateway.parseSessionFrame
import io.rivethub.app.gateway.wireJson
import org.junit.Assert.assertEquals
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
}

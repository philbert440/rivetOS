package io.rivethub.app

import io.rivethub.app.gateway.*
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import io.rivethub.app.gateway.AgentPreset
import io.rivethub.app.gateway.AgentsListResponse
import io.rivethub.app.gateway.CatalogAgent
import io.rivethub.app.gateway.CatalogAgentsResponse
import io.rivethub.app.gateway.DenFrame
import io.rivethub.app.gateway.Healthz
import io.rivethub.app.gateway.MeshOverview
import io.rivethub.app.gateway.NotificationFrame
import io.rivethub.app.gateway.SessionFrame
import io.rivethub.app.gateway.TermSpawnRequest
import io.rivethub.app.gateway.TermSpawnResponse
import io.rivethub.app.gateway.isPreset
import io.rivethub.app.gateway.parseDenFrame
import io.rivethub.app.gateway.parseNotificationFrame
import io.rivethub.app.gateway.parseSessionFrame
import io.rivethub.app.gateway.wireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WireTest {
    @Test fun `task fixtures preserve full detail and tolerate future fields`() {
        val response = wireJson.decodeFromString(TaskResponse.serializer(), """{"task":{
            "id":"12345678-1234-4234-8234-123456789abc","goal":"Review","contextRefs":[{"kind":"file","path":"README.md"}],
            "acceptanceCriteria":[{"id":"c1","description":"Tests pass","kind":"manual","future":true}],
            "spec":{"branch":"main"},"executor":"harness-session","executorTarget":"claude-code","agentId":"reviewer",
            "requestedBy":"rivethub","origin":"api","parentTaskId":"parent","chainDepth":1,"nodeAffinity":"den-a",
            "claimedBy":"worker","budget":{"maxTokens":10},"usage":{"tokens":5},"status":"completed","attempt":1,
            "maxAttempts":3,"pendingMessage":"steer","error":"diagnostic","result":{"verdict":"pass","summary":"Done"},
            "conversationId":"conversation","sessionKey":"session","harnessSessionIds":["session"],"eval":{"verdict":"verified"},
            "evalAttempt":1,"createdAt":100,"updatedAt":200,"startedAt":110,"lastHeartbeatAt":180,"completedAt":200,"durationMs":90,
            "future":true}}""")
        val task = response.task
        assertEquals("harness-session", task.executor)
        assertEquals("den-a", task.nodeAffinity)
        assertEquals("Tests pass", task.acceptanceCriteria.single().description)
        assertEquals("Done", task.result!!["summary"]!!.jsonPrimitive.content)
        assertEquals(200L, task.completedAt)
        assertEquals(90L, task.durationMs)
        assertEquals(task, wireJson.decodeFromString(TaskWire.serializer(), wireJson.encodeToString(TaskWire.serializer(), task)))
        assertEquals(TaskWire(), wireJson.decodeFromString(TaskWire.serializer(), "{}"))
        assertTrue(wireJson.decodeFromString(TasksListResponse.serializer(), "{}" ).tasks.isEmpty())
        assertEquals(listOf(task), wireJson.decodeFromString(TasksListResponse.serializer(),
            "{\"tasks\":[${wireJson.encodeToString(TaskWire.serializer(), task)}]}").tasks)
    }

    @Test fun `task create explicitly sends requester and omits optional criteria and executor`() {
        val body = wireJson.parseToJsonElement(wireJson.encodeToString(TaskCreateRequest.serializer(), TaskCreateRequest("Review", "reviewer"))).jsonObject
        assertEquals("rivethub", body["requestedBy"]!!.jsonPrimitive.content)
        assertFalse(body.containsKey("executor"))
        assertFalse(body.containsKey("acceptanceCriteria"))
        val withCriteria = TaskCreateRequest("Review", "reviewer", listOf(TaskAcceptanceCriterion("c1", "Tests pass", "manual")))
        val encoded = wireJson.encodeToString(TaskCreateRequest.serializer(), withCriteria)
        assertTrue(encoded.contains("\"kind\":\"manual\""))
        assertEquals(withCriteria, wireJson.decodeFromString(TaskCreateRequest.serializer(), encoded))
        assertEquals("{\"message\":\"Continue\"}", wireJson.encodeToString(TaskSteerRequest.serializer(), TaskSteerRequest("Continue")))
        assertEquals(TaskKillResponse(true, "running"), wireJson.decodeFromString(TaskKillResponse.serializer(), """{"ok":true,"prior":"running","future":1}"""))
        assertNull(wireJson.decodeFromString(TaskKillResponse.serializer(), """{"ok":true}""").prior)
    }

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

    @Test fun `notification escalation frame decodes`() {
        val f = parseNotificationFrame(
            """{"kind":"escalation","taskId":"t1","agentId":"reviewer","summary":"needs a call","href":"/tasks/t1","ts":1727000000000,"extra":true}""",
        )
        assertEquals(NotificationFrame.Escalation("t1", "reviewer", "needs a call", "/tasks/t1", 1727000000000L), f)
    }

    @Test fun `notification task done frame decodes every status`() {
        for (status in listOf("completed", "failed", "timeout", "killed")) {
            val f = parseNotificationFrame("""{"kind":"task.done","taskId":"t2","status":"$status","ts":5}""")
            assertEquals(NotificationFrame.TaskDone("t2", status, 5L), f)
        }
    }

    @Test fun `notification workflow gate frame decodes with and without prompt`() {
        val withPrompt = parseNotificationFrame(
            """{"kind":"workflow.gate","runId":"r1","workflowId":"wf","label":"Ship?","prompt":"Approve","href":"/workflows/runs/r1","ts":7}""",
        )
        assertEquals(NotificationFrame.WorkflowGate("r1", "wf", "Ship?", "Approve", "/workflows/runs/r1", 7L), withPrompt)
        val bare = parseNotificationFrame("""{"kind":"workflow.gate","runId":"r2","workflowId":"wf","label":"Gate","ts":8.0}""")
        val gate = bare as NotificationFrame.WorkflowGate
        assertNull(gate.prompt)
        assertEquals("/workflows/runs/r2", gate.href)
        assertEquals(8L, gate.ts)
    }

    @Test fun `notification unknown kind is Other and garbage is null`() {
        assertEquals(NotificationFrame.Other("outcome.new"), parseNotificationFrame("""{"kind":"outcome.new","id":"x"}"""))
        assertNull(parseNotificationFrame("not json"))
        assertNull(parseNotificationFrame("[1,2]"))
        assertNull(parseNotificationFrame("""{"nokind":1}"""))
        assertNull(parseNotificationFrame("""{"kind":7}"""))
        assertNull(parseNotificationFrame("""{"kind":"task.done","status":"completed","ts":1}"""))
        val noTs = parseNotificationFrame("""{"kind":"task.done","taskId":"t","ts":"soon"}""") as NotificationFrame.TaskDone
        assertEquals(0L, noTs.ts)
        assertEquals("", noTs.status)
    }
}

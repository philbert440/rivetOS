package dev.rivet.app.data.harness

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Wire → model parsing for the control plane's responses and event frames. */
class HarnessModelsTest {

    @Test
    fun `harness list reads capability flags honestly`() {
        val json = JSONObject(
            """
            {"harnesses":[
              {"harnessId":"claude-code","capabilities":{
                 "interrupt":true,"resume":true,"approvals":false,
                 "liveStream":true,"listSessions":true}},
              {"harnessId":"grok-build","capabilities":{"listSessions":true}}
            ]}
            """.trimIndent(),
        )
        val rows = HarnessDescriptor.listFrom(json)
        assertEquals(2, rows.size)
        assertTrue(rows[0].capabilities.interrupt)
        assertFalse(rows[0].capabilities.approvals)
        // Absent flags default false — never optimistic.
        assertFalse(rows[1].capabilities.interrupt)
        assertFalse(rows[1].capabilities.liveStream)
        assertTrue(rows[1].capabilities.listSessions)
    }

    @Test
    fun `descriptor rows without a harness id are dropped`() {
        val json = JSONObject("""{"harnesses":[{"capabilities":{}},{"harnessId":"hermes"}]}""")
        assertEquals(listOf("hermes"), HarnessDescriptor.listFrom(json).map { it.harnessId })
    }

    @Test
    fun `session summaries expose the native id and default to idle`() {
        val json = JSONObject(
            """
            {"sessions":[
              {"sessionId":"claude-code:9f2c-uuid","harnessId":"claude-code",
               "title":"fix the drawer","createdAt":"2026-08-09T10:00:00.000Z",
               "updatedAt":"2026-08-09T10:05:00.000Z","status":"active"},
              {"sessionId":"grok-build:01HZX","harnessId":"grok-build"}
            ]}
            """.trimIndent(),
        )
        val rows = HarnessSessionSummary.listFrom(json)
        assertEquals(2, rows.size)
        assertEquals("9f2c-uuid", rows[0].nativeSessionId)
        assertEquals(HarnessStatus.ACTIVE, rows[0].status)
        assertEquals(HarnessStatus.IDLE, rows[1].status)
        assertNull(rows[1].title)
    }

    @Test
    fun `a summary missing harnessId falls back to the canonical prefix`() {
        val row = HarnessSessionSummary.from(JSONObject("""{"sessionId":"hermes:abc"}"""))
        assertEquals("hermes", row?.harnessId)
    }

    @Test
    fun `transcript turns carry thinking, tools and model`() {
        val json = JSONObject(
            """
            {"sessionId":"claude-code:9f2c","harnessId":"claude-code","turns":[
              {"role":"user","text":"hi"},
              {"role":"assistant","text":"hello","thinking":"pondering",
               "model":"claude-opus-4","tools":[{"name":"Bash","status":"done"}]},
              {"role":"system","text":"ignored"}
            ]}
            """.trimIndent(),
        )
        val transcript = HarnessTranscript.from(json)
        assertEquals(2, transcript.turns.size)
        assertEquals("pondering", transcript.turns[1].thinking)
        assertEquals("claude-opus-4", transcript.turns[1].model)
        assertEquals(listOf("Bash"), transcript.turns[1].tools.map { it.name })
        assertNull(transcript.redirectedTo)
    }

    @Test
    fun `a redirect to the canonical id survives parsing`() {
        val transcript = HarnessTranscript.from(
            JSONObject(
                """{"sessionId":"claude-code:new","harnessId":"claude-code",
                    "turns":[],"redirectedTo":"claude-code:new"}""",
            ),
        )
        assertEquals("claude-code:new", transcript.redirectedTo)
    }

    @Test
    fun `every event type parses`() {
        fun ev(raw: String) = HarnessEvent.parse(raw)

        assertEquals(
            HarnessEvent.AssistantDelta("claude-code:a", "hi"),
            ev("""{"type":"assistant-delta","sessionId":"claude-code:a","text":"hi"}"""),
        )
        assertEquals(
            HarnessEvent.ReasoningDelta("claude-code:a", "thinking"),
            ev("""{"type":"reasoning-delta","sessionId":"claude-code:a","text":"thinking"}"""),
        )
        assertEquals(
            HarnessEvent.ToolUse("claude-code:a", "t1", "Bash"),
            ev("""{"type":"tool-use","sessionId":"claude-code:a","toolCallId":"t1","name":"Bash"}"""),
        )
        assertEquals(
            HarnessEvent.ToolResult("claude-code:a", "t1", "Bash", true),
            ev(
                """{"type":"tool-result","sessionId":"claude-code:a","toolCallId":"t1",
                    "name":"Bash","isError":true}""",
            ),
        )
        assertEquals(
            HarnessEvent.TurnComplete("claude-code:a", "end-turn"),
            ev("""{"type":"turn-complete","sessionId":"claude-code:a","stopReason":"end-turn"}"""),
        )
        assertEquals(
            HarnessEvent.Error("claude-code:a", "capability_unsupported", "no interrupt", false),
            ev(
                """{"type":"error","sessionId":"claude-code:a","code":"capability_unsupported",
                    "message":"no interrupt","retryable":false}""",
            ),
        )
        assertEquals(
            HarnessEvent.SessionUpdated("claude-code:new", "claude-code:old", HarnessStatus.ACTIVE),
            ev(
                """{"type":"session-updated","sessionId":"claude-code:new",
                    "previousSessionId":"claude-code:old","status":"active"}""",
            ),
        )
        assertEquals(
            HarnessEvent.ApprovalResolved("hermes:a", "r1", "allow-session"),
            ev(
                """{"type":"approval-resolved","sessionId":"hermes:a","requestId":"r1",
                    "decision":"allow-session"}""",
            ),
        )
    }

    @Test
    fun `an unknown event type is kept, not dropped`() {
        val event = HarnessEvent.parse("""{"type":"quantum-delta","sessionId":"hermes:a"}""")
        assertEquals(HarnessEvent.Unknown("hermes:a", "quantum-delta"), event)
    }

    @Test
    fun `unreadable frames parse to null instead of throwing`() {
        assertNull(HarnessEvent.parse("not json"))
        assertNull(HarnessEvent.parse("""{"sessionId":"hermes:a"}"""))
    }
}

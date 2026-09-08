package io.rivethub.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HarnessWireTest {
    private val sid = "claude-code:a1b2c3d4-1111-4222-8333-444455556666"

    @Test fun `descriptor round-trips models efforts and flags`() {
        val json = """{"harnessId":"claude-code","capabilities":{"interrupt":true,"resume":true,"approvals":false,"liveStream":true,"listSessions":true,"models":[{"id":"fable","label":"Fable 5.1","default":true}],"efforts":[{"id":"medium","label":"Medium","default":true}],"modelFlag":"--model","effortFlag":"--effort"}}"""
        val d = wireJson.decodeFromString(HarnessDescriptor.serializer(), json)
        assertEquals("claude-code", d.harnessId)
        assertTrue(d.capabilities.interrupt)
        assertEquals("fable", d.capabilities.models!!.single().id)
        assertEquals("--model", d.capabilities.modelFlag)
        val back = wireJson.decodeFromString(HarnessDescriptor.serializer(), wireJson.encodeToString(HarnessDescriptor.serializer(), d))
        assertEquals(d, back)
    }

    @Test fun `session summary round-trips ISO stamps and optional fields`() {
        val json = """{"sessionId":"$sid","harnessId":"claude-code","title":"T","cwd":"/tmp/p","createdAt":"2026-08-08T00:00:00.000Z","updatedAt":"2026-08-08T00:05:00.000Z","status":"idle","supersedes":"claude-code:old","model":"fable"}"""
        val s = wireJson.decodeFromString(HarnessSessionSummary.serializer(), json)
        assertEquals(sid, s.sessionId)
        assertEquals("fable", s.model)
        assertEquals("claude-code:old", s.supersedes)
        assertEquals(s, wireJson.decodeFromString(HarnessSessionSummary.serializer(), wireJson.encodeToString(HarnessSessionSummary.serializer(), s)))
    }

    @Test fun `sessions wrapper decodes a list`() {
        val json = """{"sessions":[{"sessionId":"$sid","harnessId":"claude-code","createdAt":"2026-08-08T00:00:00.000Z","updatedAt":"2026-08-08T00:05:00.000Z","status":"idle"}]}"""
        val wrap = wireJson.decodeFromString(HarnessSessionListResponse.serializer(), json)
        assertEquals(sid, wrap.sessions.single().sessionId)
    }

    @Test fun `legacy harness-sessions row uses epoch-ms updatedAt`() {
        val json = """{"sessions":[{"id":"abc","command":"grok","title":"stored","updatedAt":1000}]}"""
        val row = wireJson.decodeFromString(LegacyHarnessSessionsResponse.serializer(), json).sessions.single()
        assertEquals("abc", row.id)
        assertEquals("grok", row.command)
        assertEquals(1000L, row.updatedAt)
    }

    @Test fun `UserTurn omits attachments model and effort on a text-only encode`() {
        val names = (0 until UserTurn.serializer().descriptor.elementsCount).map {
            UserTurn.serializer().descriptor.getElementName(it)
        }
        assertTrue(names.contains("attachments"))
        assertTrue(names.contains("model"))
        assertTrue(names.contains("effort"))
        val encoded = wireJson.encodeToString(UserTurn.serializer(), UserTurn("hi"))
        assertFalse(encoded.contains("attachments"))
        assertFalse(encoded.contains("model"))
        assertFalse(encoded.contains("effort"))
        assertTrue(encoded.contains("hi"))
    }

    @Test fun `UserTurn round-trips native model effort and staged image`() {
        val t = UserTurn(
            text = "look",
            model = "gpt-5",
            effort = "high",
            attachments = listOf(UserTurnAttachment("image/png", "/node/uploads/a.png", "a.png")),
        )
        val json = wireJson.encodeToString(UserTurn.serializer(), t)
        assertTrue(json.contains("pathOrUri"))
        val back = wireJson.decodeFromString(UserTurn.serializer(), json)
        assertEquals(t, back)
    }

    @Test fun `descriptor round-trips turnOptions imageAttachments and inputModalities`() {
        val json = """{"harnessId":"codex","capabilities":{"interrupt":true,"resume":true,"approvals":true,"liveStream":true,"listSessions":true,"turnOptions":true,"imageAttachments":true,"models":[{"id":"gpt-5","label":"gpt-5","default":true,"inputModalities":["text","image"],"efforts":[{"id":"high","label":"High","default":true}]}]}}"""
        val d = wireJson.decodeFromString(HarnessDescriptor.serializer(), json)
        assertTrue(d.capabilities.turnOptions)
        assertTrue(d.capabilities.imageAttachments)
        assertEquals(listOf("text", "image"), d.capabilities.models!!.single().inputModalities)
        assertEquals("high", d.capabilities.models!!.single().efforts!!.single().id)
    }

    @Test fun `session summary round-trips transport and effort`() {
        val json = """{"sessionId":"codex:abc","harnessId":"codex","createdAt":"2026-08-08T00:00:00.000Z","updatedAt":"2026-08-08T00:05:00.000Z","status":"idle","model":"gpt-5","effort":"high","transport":"protocol"}"""
        val s = wireJson.decodeFromString(HarnessSessionSummary.serializer(), json)
        assertEquals("protocol", s.transport)
        assertEquals("high", s.effort)
        assertEquals("gpt-5", s.model)
    }

    @Test fun `UserTurn round-trips optional systemPrompt`() {
        val t = wireJson.decodeFromString(UserTurn.serializer(), """{"text":"go","systemPrompt":"be brief"}""")
        assertEquals("go", t.text)
        assertEquals("be brief", t.systemPrompt)
    }

    @Test fun `parse turn-complete`() {
        val e = parseHarnessEvent("""{"type":"turn-complete","sessionId":"$sid","turnId":"t1","stopReason":"end-turn"}""")
        val t = e as HarnessEvent.TurnComplete
        assertEquals(sid, t.sessionId)
        assertEquals("end-turn", t.stopReason)
    }

    @Test fun `parse assistant_response and assistant-delta and text as deltas`() {
        val a = parseHarnessEvent("""{"type":"assistant-delta","sessionId":"$sid","text":"hi"}""") as HarnessEvent.AssistantDelta
        assertEquals("hi", a.text)
        val b = parseHarnessEvent("""{"type":"assistant_response","sessionId":"$sid","text":"yo"}""") as HarnessEvent.AssistantDelta
        assertEquals("yo", b.text)
        val c = parseHarnessEvent("""{"type":"text","sessionId":"$sid","content":"z"}""") as HarnessEvent.AssistantDelta
        assertEquals("z", c.text)
    }

    @Test fun `parse tool_use and tool-use`() {
        val a = parseHarnessEvent("""{"type":"tool-use","sessionId":"$sid","toolCallId":"c1","name":"Bash"}""") as HarnessEvent.ToolUse
        assertEquals("Bash", a.name)
        val b = parseHarnessEvent("""{"type":"tool_use","sessionId":"$sid","toolCallId":"c2","name":"Edit"}""") as HarnessEvent.ToolUse
        assertEquals("Edit", b.name)
    }

    @Test fun `parse session-created carrying a summary`() {
        val e = parseHarnessEvent("""{"type":"session-created","sessionId":"$sid","summary":{"sessionId":"$sid","harnessId":"claude-code","createdAt":"2026-08-08T00:00:00.000Z","updatedAt":"2026-08-08T00:05:00.000Z","status":"active","title":"live"}}""") as HarnessEvent.SessionCreated
        assertEquals("live", e.summary.title)
        assertEquals("active", e.summary.status)
    }

    @Test fun `parse session-updated with previousSessionId`() {
        val e = parseHarnessEvent("""{"type":"session-updated","sessionId":"$sid","previousSessionId":"claude-code:old","status":"idle"}""") as HarnessEvent.SessionUpdated
        assertEquals("claude-code:old", e.previousSessionId)
        assertEquals("idle", e.status)
    }

    @Test fun `parse error`() {
        val e = parseHarnessEvent("""{"type":"error","sessionId":"$sid","code":"invalid_session_id","message":"gone"}""") as HarnessEvent.Error
        assertEquals("invalid_session_id", e.code)
        assertEquals("gone", e.message)
    }

    @Test fun `unknown type becomes Unknown carrying raw`() {
        val e = parseHarnessEvent("""{"type":"not-a-real-event","sessionId":"$sid","requestId":"r1"}""") as HarnessEvent.Unknown
        assertEquals("not-a-real-event", e.type)
        assertEquals("r1", e.raw["requestId"]!!.jsonPrimitiveContent())
    }

    @Test fun `parse transcript snapshot with context fields`() {
        val e = parseHarnessEvent(
            """{"type":"transcript","sessionId":"$sid","rev":3,"from":0,"total":1,"command":"claude","truncatedBefore":true,"contextWindow":200000,"compactAt":165000,"contextSource":"spawn","turns":[{"role":"assistant","text":"hi"}]}""",
        ) as HarnessEvent.Transcript
        assertEquals(sid, e.sessionId)
        assertEquals(3, e.rev)
        assertEquals(0, e.from)
        assertEquals(1, e.total)
        assertEquals("claude", e.command)
        assertTrue(e.truncatedBefore)
        assertEquals(200_000, e.contextWindow)
        assertEquals(165_000, e.compactAt)
        assertEquals("spawn", e.contextSource)
        assertEquals("hi", e.turns.single().text)
    }

    @Test fun `parse status with phase and tool`() {
        val e = parseHarnessEvent(
            """{"type":"status","sessionId":"$sid","status":"working","since":1700000000000,"source":"transcript","phase":"tool","tool":{"name":"Bash","toolCallId":"c1"},"promptId":"p1"}""",
        ) as HarnessEvent.Status
        assertEquals("working", e.status)
        assertEquals(1_700_000_000_000L, e.since)
        assertEquals("transcript", e.source)
        assertEquals("tool", e.phase)
        assertEquals("Bash", e.toolName)
        assertEquals("c1", e.toolCallId)
        assertEquals("p1", e.promptId)
    }

    @Test fun `parse prompt with questions and resolved`() {
        val open = parseHarnessEvent(
            """{"type":"prompt","sessionId":"$sid","promptId":"p1","kind":"ask-user","toolName":"AskUserQuestion","questions":[{"question":"Go?","header":"Auth","multiSelect":false,"options":[{"label":"Yes","description":"do it"},{"label":"No"}]}]}""",
        ) as HarnessEvent.Prompt
        assertEquals("p1", open.promptId)
        assertEquals("AskUserQuestion", open.toolName)
        assertFalse(open.resolved)
        assertEquals("Go?", open.questions.single().question)
        assertEquals("Yes", open.questions.single().options[0].label)
        assertFalse(open.questions.single().freeText)
        val done = parseHarnessEvent(
            """{"type":"prompt","sessionId":"$sid","promptId":"p1","kind":"ask-user","toolName":"AskUserQuestion","questions":[],"resolved":{"at":1,"answerText":"Yes"}}""",
        ) as HarnessEvent.Prompt
        assertTrue(done.resolved)
        assertEquals("Yes", done.answerText)
        assertNull(open.screen)
        assertNull(done.screen)
    }

    @Test fun `parse prompt with screen current and total`() {
        val e = parseHarnessEvent(
            """{"type":"prompt","sessionId":"$sid","promptId":"p2","kind":"ask-user","toolName":"AskUserQuestion","questions":[{"question":"Go?","multiSelect":false,"options":[{"label":"Yes"}]}],"screen":{"current":0,"total":3}}""",
        ) as HarnessEvent.Prompt
        assertEquals("p2", e.promptId)
        assertEquals(0, e.screen!!.current)
        assertEquals(3, e.screen!!.total)
        assertEquals("Go?", e.questions.single().question)
    }

    @Test fun `parse prompt without screen still parses`() {
        val e = parseHarnessEvent(
            """{"type":"prompt","sessionId":"$sid","promptId":"p3","kind":"ask-user","toolName":"AskUserQuestion","questions":[{"question":"Go?","options":[{"label":"A"},{"label":"B"}]}]}""",
        ) as HarnessEvent.Prompt
        assertEquals("p3", e.promptId)
        assertNull(e.screen)
        assertFalse(e.resolved)
        assertEquals(2, e.questions.single().options.size)
        assertFalse(e.questions.single().freeText)
    }

    @Test fun `parse prompt treats missing options as free-text`() {
        val e = parseHarnessEvent(
            """{"type":"prompt","sessionId":"$sid","promptId":"p4","kind":"ask-user","toolName":"requestUserInput","questions":[{"question":"Describe it","freeText":true}]}""",
        ) as HarnessEvent.Prompt
        assertTrue(e.questions.single().freeText)
        assertTrue(e.questions.single().options.isEmpty())
        val nullOpts = parseHarnessEvent(
            """{"type":"prompt","sessionId":"$sid","promptId":"p5","kind":"ask-user","toolName":"requestUserInput","questions":[{"question":"Name?","options":null}]}""",
        ) as HarnessEvent.Prompt
        assertTrue(nullOpts.questions.single().freeText)
        val nullOptsChoices = parseHarnessEvent(
            """{"type":"prompt","sessionId":"$sid","promptId":"p5b","kind":"ask-user","toolName":"requestUserInput","questions":[{"question":"Go?","options":null,"choices":[{"label":"Yes"},{"label":"No"}]}]}""",
        ) as HarnessEvent.Prompt
        assertEquals(listOf("Yes", "No"), nullOptsChoices.questions.single().options.map { it.label })
        assertFalse(nullOptsChoices.questions.single().freeText)
        val empty = parseHarnessEvent(
            """{"type":"prompt","sessionId":"$sid","promptId":"p6","kind":"ask-user","toolName":"AskUserQuestion","questions":[{"question":"Go?","options":[]}]}""",
        ) as HarnessEvent.Prompt
        assertFalse(empty.questions.single().freeText)
    }

    @Test fun `parse approval-request and approval-resolved`() {
        val req = parseHarnessEvent(
            """{"type":"approval-request","sessionId":"$sid","requestId":"r1","name":"Bash","reason":"Do you want to proceed?","options":["1","2","3"],"input":{"command":"ls"}}""",
        ) as HarnessEvent.ApprovalRequest
        assertEquals("r1", req.requestId)
        assertEquals("Bash", req.name)
        assertEquals("Do you want to proceed?", req.reason)
        assertEquals(listOf("1", "2", "3"), req.options)
        assertEquals("ls", req.input!!["command"]!!.jsonPrimitiveContent())
        val res = parseHarnessEvent(
            """{"type":"approval-resolved","sessionId":"$sid","requestId":"r1","decision":"allow"}""",
        ) as HarnessEvent.ApprovalResolved
        assertEquals("allow", res.decision)
    }

    @Test fun `transcript turn round-trips id input resultText stopReason lastBlock complete`() {
        val json = """{"sessionId":"$sid","harnessId":"claude-code","turns":[{"role":"assistant","text":"done","stopReason":"end_turn","lastBlock":"text","complete":true,"compact":true,"tools":[{"name":"AskUserQuestion","status":"done","id":"toolu_1","input":{"questions":[1]},"resultText":"Yes"}]}]}"""
        val body = wireJson.decodeFromString(HarnessSessionTranscriptResponse.serializer(), json)
        val turn = body.turns.single()
        assertEquals("end_turn", turn.stopReason)
        assertEquals("text", turn.lastBlock)
        assertEquals(true, turn.complete)
        assertEquals(true, turn.compact)
        val tool = turn.tools!!.single()
        assertEquals("toolu_1", tool.id)
        assertEquals("Yes", tool.resultText)
        assertTrue(tool.input != null)
        val back = wireJson.decodeFromString(
            HarnessSessionTranscriptResponse.serializer(),
            wireJson.encodeToString(HarnessSessionTranscriptResponse.serializer(), body),
        )
        assertEquals(body, back)
    }

    @Test fun `junk json is null not thrown`() {
        assertNull(parseHarnessEvent("not json"))
        assertNull(parseHarnessEvent(""))
    }

    @Test fun `sessionKeyEnc of an id containing colon is unpadded base64url`() {
        val enc = sessionKeyEnc(sid)
        assertTrue(enc.matches(Regex("[A-Za-z0-9_-]+")))
        assertFalse(enc.contains("="))
        assertFalse(enc.contains("+"))
        assertFalse(enc.contains("/"))
        assertEquals(sid, sessionKeyDec(enc))
        assertFalse(enc.contains(":"))
    }

    @Test fun `StagedUploadResponse round-trips ISO expiresAt`() {
        val json = """{"uri":"/tmp/uploads/x.png","name":"x.png","mime":"image/png","size":4,"expiresAt":"2026-09-02T18:00:00.000Z"}"""
        val staged = wireJson.decodeFromString(StagedUploadResponse.serializer(), json)
        assertEquals("/tmp/uploads/x.png", staged.uri)
        assertEquals("image/png", staged.mime)
        assertEquals(4L, staged.size)
        assertEquals("2026-09-02T18:00:00.000Z", staged.expiresAt)
        val absent = wireJson.decodeFromString(StagedUploadResponse.serializer(), """{"uri":"/tmp/uploads/x.png"}""")
        assertNull(absent.expiresAt)
    }

    @Test fun `transcript turn round-trips tools and usage`() {
        val json = """{"sessionId":"$sid","harnessId":"claude-code","turns":[{"role":"assistant","text":"done","thinking":"hmm","model":"fable","tools":[{"name":"Bash","status":"done","args":{"command":"ls"}}],"usage":{"promptTokens":10,"completionTokens":4,"cachedTokens":0}}]}"""
        val body = wireJson.decodeFromString(HarnessSessionTranscriptResponse.serializer(), json)
        val turn = body.turns.single()
        assertEquals("done", turn.text)
        assertEquals("Bash", turn.tools!!.single().name)
        assertEquals("done", turn.tools!!.single().status)
        assertEquals("ls", turn.tools!!.single().args?.get("command")?.jsonPrimitiveContent())
        assertEquals(10, turn.usage!!.promptTokens)
        assertEquals(4, turn.usage!!.completionTokens)
        val back = wireJson.decodeFromString(
            HarnessSessionTranscriptResponse.serializer(),
            wireJson.encodeToString(HarnessSessionTranscriptResponse.serializer(), body),
        )
        assertEquals(body, back)
    }

    @Test fun `parse harness-capabilities registry frame`() {
        val e = parseHarnessEvent("""{"type":"harness-capabilities","harnessId":"claude-code","capabilities":{"interrupt":true,"resume":true,"approvals":false,"liveStream":true,"listSessions":true},"changed":{"interrupt":true},"reason":"pty loaded"}""") as HarnessEvent.CapabilitiesChanged
        assertEquals("claude-code", e.harnessId)
        assertTrue(e.capabilities.interrupt)
        assertEquals("pty loaded", e.reason)
        assertEquals("true", e.changed?.get("interrupt")?.jsonPrimitiveContent())
    }

    @Test fun `nativeIdOf splits on the first colon only`() {
        assertEquals("a1b2c3d4-1111-4222-8333-444455556666", nativeIdOf(sid))
        assertEquals("sess:42", nativeIdOf("grok-build:sess:42"))
        assertNull(nativeIdOf("a1b2c3d4-1111-4222-8333-444455556666"))
        assertNull(nativeIdOf("not-a-session-id"))
    }

    @Test fun `nativeIdOf accepts codex`() {
        assertEquals("a1b2c3d4-1111-4222-8333-444455556666", nativeIdOf("codex:a1b2c3d4-1111-4222-8333-444455556666"))
        assertTrue("codex" in HARNESS_IDS)
    }

    @Test fun `isTurnInFlight matches only the typed 409`() {
        assertTrue(isTurnInFlight(TurnInFlight()))
        assertTrue(isTurnInFlightStatus(409, "turn_in_flight"))
        assertFalse(isTurnInFlightStatus(409, "session_id_collision"))
        assertFalse(isTurnInFlightStatus(501, "turn_in_flight"))
        assertFalse(isTurnInFlight(GatewayException(409, "nope")))
    }

    @Test fun `transcript response decodes the context-bar contract and tolerates its absence`() {
        val full = wireJson.decodeFromString(
            HarnessSessionTranscriptResponse.serializer(),
            """{"sessionId":"$sid","harnessId":"claude-code","turns":[],"contextWindow":200000,"compactAt":165000,"contextSource":"spawn"}""",
        )
        assertEquals(200_000, full.contextWindow)
        assertEquals(165_000, full.compactAt)
        assertEquals("spawn", full.contextSource)
        val legacy = wireJson.decodeFromString(
            HarnessSessionTranscriptResponse.serializer(),
            """{"sessionId":"$sid","harnessId":"claude-code","turns":[]}""",
        )
        assertNull(legacy.contextWindow)
        assertNull(legacy.compactAt)
        assertNull(legacy.contextSource)
    }

    @Test fun `den session info and messages response decode the context-bar contract`() {
        val info = wireJson.decodeFromString(
            DenSessionInfo.serializer(),
            """{"id":"$sid","contextWindow":200000,"compactAt":165000,"contextSource":"observed"}""",
        )
        assertEquals(200_000, info.contextWindow)
        assertEquals(165_000, info.compactAt)
        assertEquals("observed", info.contextSource)
        val msgs = wireJson.decodeFromString(
            SessionMessagesResponse.serializer(),
            """{"messages":[],"contextWindow":200000,"compactAt":165000,"contextSource":"default"}""",
        )
        assertEquals(200_000, msgs.contextWindow)
        assertEquals(165_000, msgs.compactAt)
        assertEquals("default", msgs.contextSource)
    }
}

private fun kotlinx.serialization.json.JsonElement.jsonPrimitiveContent(): String =
    (this as kotlinx.serialization.json.JsonPrimitive).content

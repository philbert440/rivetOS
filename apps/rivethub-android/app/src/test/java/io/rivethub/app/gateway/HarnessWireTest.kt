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

    @Test fun `UserTurn has no attachments field`() {
        val names = (0 until UserTurn.serializer().descriptor.elementsCount).map {
            UserTurn.serializer().descriptor.getElementName(it)
        }
        assertFalse(names.contains("attachments"))
        val encoded = wireJson.encodeToString(UserTurn.serializer(), UserTurn("hi"))
        assertFalse(encoded.contains("attachments"))
        assertTrue(encoded.contains("hi"))
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
        val e = parseHarnessEvent("""{"type":"approval-request","sessionId":"$sid","requestId":"r1"}""") as HarnessEvent.Unknown
        assertEquals("approval-request", e.type)
        assertEquals("r1", e.raw["requestId"]!!.jsonPrimitiveContent())
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

    @Test fun `isTurnInFlight matches only the typed 409`() {
        assertTrue(isTurnInFlight(TurnInFlight()))
        assertTrue(isTurnInFlightStatus(409, "turn_in_flight"))
        assertFalse(isTurnInFlightStatus(409, "session_id_collision"))
        assertFalse(isTurnInFlightStatus(501, "turn_in_flight"))
        assertFalse(isTurnInFlight(GatewayException(409, "nope")))
    }
}

private fun kotlinx.serialization.json.JsonElement.jsonPrimitiveContent(): String =
    (this as kotlinx.serialization.json.JsonPrimitive).content

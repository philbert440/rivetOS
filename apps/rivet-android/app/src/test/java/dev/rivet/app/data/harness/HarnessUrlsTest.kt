package dev.rivet.app.data.harness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * URL shapes of the control plane. These are the contract's "As built" table,
 * pinned: `/api/harness-sessions` (not `/api/sessions`), `enc(SessionId)` in
 * the path, and WS resources on the query string.
 */
class HarnessUrlsTest {

    private val urls = HarnessUrls("http://node.example:5174/")
    private val sid = "claude-code:9f2c-4b1a-uuid"
    private val enc = HarnessSessionIds.encodeSegment(sid)

    @Test
    fun `base drops a trailing slash`() {
        assertEquals("http://node.example:5174", urls.base)
        assertEquals("http://node.example:5174", HarnessUrls("http://node.example:5174 ").base)
    }

    @Test
    fun `registry routes`() {
        assertEquals("http://node.example:5174/api/harnesses", urls.harnesses())
        assertEquals("http://node.example:5174/api/harnesses/claude-code", urls.harness("claude-code"))
        assertEquals(
            "http://node.example:5174/api/harnesses/grok-build/sessions",
            urls.harnessSessions("grok-build"),
        )
    }

    @Test
    fun `session routes carry the base64url segment`() {
        assertEquals("http://node.example:5174/api/harness-sessions/$enc", urls.session(sid))
        assertEquals("http://node.example:5174/api/harness-sessions/$enc/resume", urls.resume(sid))
        assertEquals("http://node.example:5174/api/harness-sessions/$enc/turns", urls.turns(sid))
        assertEquals(
            "http://node.example:5174/api/harness-sessions/$enc/interrupt",
            urls.interrupt(sid),
        )
        assertEquals(
            "http://node.example:5174/api/harness-sessions/$enc/transcript",
            urls.transcript(sid),
        )
        assertEquals(
            "http://node.example:5174/api/harness-sessions/$enc/approvals/req-1",
            urls.approval(sid, "req-1"),
        )
    }

    @Test
    fun `a slash in the native id never reaches the path`() {
        val pathy = "claude-code:-home-rivet-proj/9f2c-uuid"
        val url = urls.transcript(pathy)
        val tail = url.removePrefix("http://node.example:5174/api/harness-sessions/")
        val segment = tail.removeSuffix("/transcript")
        assertFalse(segment.contains("/"))
        assertEquals(pathy, HarnessSessionIds.decodeSegment(segment))
    }

    @Test
    fun `uploads put metadata on the query string`() {
        assertEquals(
            "http://node.example:5174/api/uploads?name=shot.png&mime=image%2Fpng",
            urls.upload("shot.png", "image/png"),
        )
        assertEquals(
            "http://node.example:5174/api/uploads?name=notes.txt",
            urls.upload("notes.txt", null),
        )
    }

    @Test
    fun `session websocket rides the query string with the token`() {
        assertEquals(
            "ws://node.example:5174/api/harness-sessions/ws?session=$enc",
            urls.sessionWs(sid, null),
        )
        assertEquals(
            "ws://node.example:5174/api/harness-sessions/ws?session=$enc&token=s3cret",
            urls.sessionWs(sid, "s3cret"),
        )
    }

    @Test
    fun `registry websocket omits the harness filter when unset`() {
        assertEquals("ws://node.example:5174/api/harnesses/ws", urls.harnessesWs(null, null))
        assertEquals(
            "ws://node.example:5174/api/harnesses/ws?harness=kimi-code",
            urls.harnessesWs("kimi-code", null),
        )
        assertEquals(
            "ws://node.example:5174/api/harnesses/ws?token=t",
            urls.harnessesWs(" ", "t"),
        )
    }

    @Test
    fun `https upgrades to wss`() {
        val secure = HarnessUrls("https://node.example")
        assertTrue(secure.sessionWs(sid, null).startsWith("wss://node.example/"))
        assertTrue(secure.harnessesWs(null, null).startsWith("wss://node.example/"))
    }

    @Test
    fun `a bare native id rides as a plain segment`() {
        assertEquals(
            "http://node.example:5174/api/harness-sessions/9f2c-uuid/transcript",
            urls.transcript("9f2c-uuid"),
        )
    }
}

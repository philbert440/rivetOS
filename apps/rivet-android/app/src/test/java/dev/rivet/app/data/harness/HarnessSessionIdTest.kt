package dev.rivet.app.data.harness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * SessionId codec — parse on the FIRST colon, and `enc()`/`dec()` round-trip
 * for ids containing `:` and `/`, which is exactly why the segment is
 * base64url and not percent-encoding.
 *
 * Mirrors `packages/types/src/harness-session-id.test.ts`.
 */
class HarnessSessionIdTest {

    private fun expectInvalid(block: () -> Unit) {
        try {
            block()
            fail("expected InvalidSessionIdException")
        } catch (_: InvalidSessionIdException) {
            // expected
        }
    }

    // ---- parse ---------------------------------------------------------------

    @Test
    fun `parses a canonical id`() {
        val parsed = HarnessSessionIds.parse("claude-code:a1b2c3d4")
        assertEquals("claude-code", parsed.harnessId)
        assertEquals("a1b2c3d4", parsed.nativeSessionId)
    }

    @Test
    fun `splits on the first colon only`() {
        val parsed = HarnessSessionIds.parse("grok-build:sess:01HZX:tail")
        assertEquals("grok-build", parsed.harnessId)
        assertEquals("sess:01HZX:tail", parsed.nativeSessionId)
    }

    @Test
    fun `keeps slashes in the native half`() {
        val parsed = HarnessSessionIds.parse("claude-code:home-rivet-proj/9f2c-uuid")
        assertEquals("home-rivet-proj/9f2c-uuid", parsed.nativeSessionId)
    }

    @Test
    fun `rejects unknown harness ids, whitespace and empty halves`() {
        expectInvalid { HarnessSessionIds.parse("claude:abc") }
        expectInvalid { HarnessSessionIds.parse("cc:abc") }
        expectInvalid { HarnessSessionIds.parse(" claude-code:abc") }
        expectInvalid { HarnessSessionIds.parse("claude-code:abc ") }
        expectInvalid { HarnessSessionIds.parse("claude-code:") }
        expectInvalid { HarnessSessionIds.parse(":abc") }
        expectInvalid { HarnessSessionIds.parse("bare-uuid") }
    }

    @Test
    fun `parseOrNull and isSessionId agree with parse`() {
        assertNull(HarnessSessionIds.parseOrNull("bare-uuid"))
        assertFalse(HarnessSessionIds.isSessionId("bare-uuid"))
        assertTrue(HarnessSessionIds.isSessionId("hermes:9b41-uuid"))
        assertEquals("9b41-uuid", HarnessSessionIds.nativeIdOf("hermes:9b41-uuid"))
        assertNull(HarnessSessionIds.nativeIdOf("9b41-uuid"))
    }

    @Test
    fun `format validates and round-trips through parse`() {
        val id = HarnessSessionIds.format("kimi-code", "c7f2-uuid")
        assertEquals("kimi-code:c7f2-uuid", id)
        assertEquals("c7f2-uuid", HarnessSessionIds.parse(id).nativeSessionId)
        expectInvalid { HarnessSessionIds.format("claude", "abc") }
        expectInvalid { HarnessSessionIds.format("claude-code", "") }
    }

    // ---- enc / dec -----------------------------------------------------------

    @Test
    fun `enc dec round-trips ids containing a colon`() {
        val id = "grok-build:sess:01HZXABCDEF"
        val segment = HarnessSessionIds.encodeSegment(id)
        assertTrue(segment.matches(Regex("^[A-Za-z0-9_-]+$")))
        assertEquals(id, HarnessSessionIds.decodeSegment(segment))
    }

    @Test
    fun `enc dec round-trips ids containing a slash`() {
        val id = "claude-code:-home-rivet-projects/9f2c-4b1a-uuid"
        val segment = HarnessSessionIds.encodeSegment(id)
        assertFalse(segment.contains("/"))
        assertFalse(segment.contains("+"))
        assertFalse(segment.contains("="))
        assertEquals(id, HarnessSessionIds.decodeSegment(segment))
    }

    @Test
    fun `enc dec round-trips non-ascii native ids`() {
        val id = "hermes:会話-☃-01"
        assertEquals(id, HarnessSessionIds.decodeSegment(HarnessSessionIds.encodeSegment(id)))
    }

    @Test
    fun `enc is unpadded base64url of the utf-8 bytes`() {
        // 'claude-code:abcd' is 16 bytes, so standard base64 would pad.
        val segment = HarnessSessionIds.encodeSegment("claude-code:abcd")
        assertEquals("Y2xhdWRlLWNvZGU6YWJjZA", segment)
    }

    @Test
    fun `enc refuses a non-canonical id`() {
        expectInvalid { HarnessSessionIds.encodeSegment("claude:abc") }
        expectInvalid { HarnessSessionIds.encodeSegment("bare-uuid") }
        expectInvalid { HarnessSessionIds.encodeSegment(" claude-code:abc") }
    }

    @Test
    fun `dec refuses padded, non-base64url and non-canonical payloads`() {
        expectInvalid { HarnessSessionIds.decodeSegment("") }
        expectInvalid { HarnessSessionIds.decodeSegment("not base64url!") }
        // A padded encoding of a perfectly good id is still rejected.
        val padded = java.util.Base64.getUrlEncoder()
            .encodeToString("claude-code:abcd".toByteArray(Charsets.UTF_8))
        assertTrue(padded.endsWith("="))
        expectInvalid { HarnessSessionIds.decodeSegment(padded) }
        // Decodes cleanly, but not to a canonical SessionId.
        val bare = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString("bare-uuid".toByteArray(Charsets.UTF_8))
        expectInvalid { HarnessSessionIds.decodeSegment(bare) }
    }

    @Test
    fun `dec refuses bytes that are not valid utf-8`() {
        val segment = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(byteArrayOf(0xC3.toByte(), 0x28))
        expectInvalid { HarnessSessionIds.decodeSegment(segment) }
    }

    // ---- segment selection ---------------------------------------------------

    @Test
    fun `segmentFor encodes canonical ids and passes bare native ids through`() {
        val canonical = "claude-code:9f2c-uuid"
        assertEquals(
            HarnessSessionIds.encodeSegment(canonical),
            HarnessSessionIds.segmentFor(canonical),
        )
        // The documented legacy shape: no harness prefix to encode, so it rides
        // as a plain percent-encoded segment (gateway-client parity).
        assertEquals("9f2c-uuid", HarnessSessionIds.segmentFor("9f2c-uuid"))
    }

    @Test
    fun `urlEncode escapes spaces as percent-20 not plus`() {
        assertEquals("a%20b", HarnessSessionIds.urlEncode("a b"))
        assertEquals("a%2Fb", HarnessSessionIds.urlEncode("a/b"))
    }

    @Test
    fun `roster commands are labels, never key material`() {
        assertEquals("claude", HarnessIds.rosterCommand(HarnessIds.CLAUDE_CODE))
        assertEquals("grok", HarnessIds.rosterCommand(HarnessIds.GROK_BUILD))
        assertEquals("kimi", HarnessIds.rosterCommand(HarnessIds.KIMI_CODE))
        assertEquals("hermes", HarnessIds.rosterCommand(HarnessIds.HERMES))
        assertEquals(4, HarnessIds.ALL.size)
    }
}

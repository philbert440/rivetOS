package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class HubReducersTest {
    @Test fun `claude grok kimi hermes map onto brief tokens`() {
        assertEquals(AccentToken.Em, harnessAccentToken("claude-code"))
        assertEquals(AccentToken.Link, harnessAccentToken("grok-build"))
        assertEquals(AccentToken.Warn, harnessAccentToken("kimi-code"))
        assertEquals(AccentToken.Red, harnessAccentToken("hermes"))
        assertEquals(AccentToken.InkDim, harnessAccentToken("deepseek-harness"))
        assertEquals(AccentToken.Em, harnessAccentToken(null, "claude"))
        assertEquals(AccentToken.InkDim, harnessAccentToken(null, null))
    }

    @Test fun `harnessIdForAgent maps catalog ids`() {
        assertEquals("claude-code", harnessIdForAgent("claude", "claude-cli"))
        assertEquals("grok-build", harnessIdForAgent("grok", null))
        assertEquals("kimi-code", harnessIdForAgent("kimi-code", null))
        assertEquals("hermes", harnessIdForAgent("hermes", null))
        assertEquals("deepseek-harness", harnessIdForAgent("dsh", null))
        assertEquals(null, harnessIdForAgent("wiki", "local"))
    }

    @Test fun `relativeAge buckets`() {
        val now = 1_700_000_000_000L
        assertEquals(RelativeAge.Empty, relativeAge(0, now))
        assertEquals(RelativeAge.Now, relativeAge(now - 10_000, now))
        assertEquals(RelativeAge.Minutes(3), relativeAge(now - 3 * 60_000, now))
        assertEquals(RelativeAge.Hours(2), relativeAge(now - 2 * 3_600_000, now))
        assertEquals(RelativeAge.Days(3), relativeAge(now - 3 * 86_400_000, now))
        assertEquals(RelativeAge.Weeks(2), relativeAge(now - 14 * 86_400_000, now))
    }

    @Test fun `401 and 403 are cert refused`() {
        assertEquals(EnrollErrorKind.CertRefused, enrollError(GatewayException(401, "no")).kind)
        assertEquals(EnrollErrorKind.CertRefused, enrollError(GatewayException(403, "no")).kind)
    }

    @Test fun `timeout and unknown host are typed`() {
        assertEquals(EnrollErrorKind.Timeout, enrollError(SocketTimeoutException("t")).kind)
        assertEquals(EnrollErrorKind.Timeout, enrollError(RuntimeException(SocketTimeoutException("t"))).kind)
        assertEquals(EnrollErrorKind.Unreachable, enrollError(UnknownHostException("x")).kind)
    }

    @Test fun `other errors keep the detail`() {
        val e = enrollError(IllegalStateException("boom"))
        assertEquals(EnrollErrorKind.Other, e.kind)
        assertEquals("boom", e.detail)
    }

    @Test fun `pointer persist round-trips`() {
        val pointers = AgentPointers { 9 }
        pointers.set("a", "sess", "https://192.0.2.10:5174")
        val encoded = encodePointers(pointers.all())
        val decoded = decodePointers(encoded)
        assertEquals("sess", decoded["a"]!!.sessionId)
        assertEquals("https://192.0.2.10:5174", decoded["a"]!!.nodeBaseUrl)
    }

    @Test fun `decodePointers skips malformed rows`() {
        val decoded = decodePointers(mapOf("a" to "no-tab", "b" to "\turl", "c" to "sid\thttps://192.0.2.10:5174"))
        assertEquals(setOf("c"), decoded.keys)
    }

    @Test fun `https entry URL is accepted and http is not`() {
        assertEquals(null, validateEntryUrl("https://192.0.2.10:5174"))
        assertEquals(null, validateEntryUrl("  HTTPS://192.0.2.10:5174/  "))
        assertEquals(EntryUrlError.NotHttps, validateEntryUrl("http://192.0.2.10:5174"))
        assertEquals(EntryUrlError.Blank, validateEntryUrl("  "))
    }

    @Test fun `cleartext IOException is a typed enroll error`() {
        val e = enrollError(java.io.IOException("Cleartext HTTP traffic to 192.0.2.10 not permitted"))
        assertEquals(EnrollErrorKind.Cleartext, e.kind)
    }

    @Test fun `Screen Chat carries nodeDenUrl independently of the view node`() {
        val chat = io.rivethub.app.ui.Screen.Chat(
            sessionKey = "s",
            nodeDenUrl = "https://192.0.2.10:5174",
            harnessId = "claude-code",
            title = "t",
            draft = false,
        )
        assertEquals("https://192.0.2.10:5174", chat.nodeDenUrl)
    }

    @Test fun `locate tags the node without rewriting the item key`() {
        val item = ChatItem("k", ChatItemKind.DRAFT, "new conversation")
        val loc = locate(item, "ct115", "ct115", "https://192.0.2.10:5174")
        assertEquals("k", loc.item.key)
        assertEquals("ct115", loc.nodeId)
        assertEquals("https://192.0.2.10:5174", loc.nodeDenUrl)
    }
}

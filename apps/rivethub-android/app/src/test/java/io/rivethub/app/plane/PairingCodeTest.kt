package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class PairingCodeTest {
    private val pin = "022ab72bf949c39a134d766ece5b288c60b51780c77540bf84f16b4944e37433"

    private fun qr(
        v: String = "1",
        kind: String = "rivethub-pair",
        gateway: String = "https://192.168.1.20:5174",
        token: String = "tok",
        cert: String = pin,
    ) = """{"v":$v,"kind":"$kind","gateway":"$gateway","token":"$token","certSha256":"$cert"}"""

    @Test fun `parses the CLI payload`() {
        assertEquals(
            PairingParse.Ok(PairingCode("https://192.168.1.20:5174", "tok", pin)),
            parsePairingCode(qr()),
        )
    }

    @Test fun `trims a trailing slash and lowercases the pin`() {
        val parsed = parsePairingCode(qr(gateway = "https://h:5174/", cert = pin.uppercase()))
        assertEquals(PairingParse.Ok(PairingCode("https://h:5174", "tok", pin)), parsed)
    }

    @Test fun `ignores unknown keys`() {
        val withExtra = qr().dropLast(1) + ""","extra":true}"""
        assertTrue(parsePairingCode(withExtra) is PairingParse.Ok)
    }

    @Test fun `a rivethub link decodes to the same code`() {
        val payload = qr()
        val d = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toByteArray())
        val link = "rivethub://pair?d=$d"
        assertTrue(looksLikePairingCode(link))
        assertEquals(parsePairingCode(payload), parsePairingCode(link))
    }

    @Test fun `the intent uri the system scanner launches decodes to the same code`() {
        val payload = qr()
        val d = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toByteArray())
        val intent = "intent://pair?d=$d#Intent;scheme=rivethub;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end"
        assertTrue(looksLikePairingCode(intent))
        assertEquals(parsePairingCode(payload), parsePairingCode(intent))
        assertFalse(looksLikePairingCode("intent://pair?d=$d#Intent;scheme=other;end"))
    }

    @Test fun `a link that is not a pairing payload is rejected`() {
        val other = """{"v":1,"kind":"rivet-mesh-enroll"}"""
        val d = Base64.getUrlEncoder().withoutPadding().encodeToString(other.toByteArray())
        assertEquals(PairingParse.Err(PairingCodeError.NotPairing), parsePairingCode("rivethub://pair?d=$d"))
        assertEquals(PairingParse.Err(PairingCodeError.NotPairing), parsePairingCode("rivethub://pair"))
        assertTrue(looksLikePairingCode("rivethub://pair"))
        assertFalse(looksLikePairingCode("rivethub://other"))
    }

    @Test fun `other QR codes are not pairing codes`() {
        assertEquals(PairingParse.Err(PairingCodeError.NotPairing), parsePairingCode("https://example.com"))
        assertEquals(PairingParse.Err(PairingCodeError.NotPairing), parsePairingCode("[1,2]"))
        assertEquals(PairingParse.Err(PairingCodeError.NotPairing), parsePairingCode(qr(kind = "rivet-mesh-enroll")))
        assertFalse(looksLikePairingCode("https://example.com"))
        assertTrue(looksLikePairingCode(qr()))
    }

    @Test fun `a future version is unsupported`() {
        assertEquals(PairingParse.Err(PairingCodeError.Unsupported), parsePairingCode(qr(v = "2")))
        assertEquals(PairingParse.Err(PairingCodeError.Unsupported), parsePairingCode(qr(v = "\"x\"")))
    }

    @Test fun `cleartext gateways, blank tokens and bad pins are invalid`() {
        val invalid = PairingParse.Err(PairingCodeError.Invalid)
        assertEquals(invalid, parsePairingCode(qr(gateway = "http://192.168.1.20:5174")))
        assertEquals(invalid, parsePairingCode(qr(gateway = "")))
        assertEquals(invalid, parsePairingCode(qr(token = "")))
        assertEquals(invalid, parsePairingCode(qr(cert = "abc")))
        assertEquals(invalid, parsePairingCode(qr(cert = "z".repeat(64))))
    }

    @Test fun `only a rivethub pair link is taken from a launch intent`() {
        val link = "rivethub://pair?d=abc"
        assertEquals(link, pairingLinkFromIntent("android.intent.action.VIEW", " $link "))
        val view = "android.intent.action.VIEW"
        assertEquals("RIVETHUB://PAIR?d=abc", pairingLinkFromIntent(view, "RIVETHUB://PAIR?d=abc"))
        // Raw JSON, other schemes, other hosts and other actions are not pairing requests.
        val notLinks: List<String?> = listOf(
            qr(),
            "https://example.com/?x=\"rivethub-pair\"",
            "rivethub://other?d=abc",
            "rivethub://pair",
            "intent://pair?d=abc#Intent;scheme=rivethub;end",
            "",
            null,
        )
        for (data in notLinks) assertEquals(null, pairingLinkFromIntent(view, data))
        assertEquals(null, pairingLinkFromIntent("android.intent.action.SEND", link))
        assertEquals(null, pairingLinkFromIntent(null, link))
    }

    @Test fun `the confirmation names the computer by host and port`() {
        assertEquals("192.0.2.20:5174", pairingGatewayLabel(PairingCode("https://192.0.2.20:5174", "tok", pin)))
        assertEquals("node.example.com", pairingGatewayLabel(PairingCode("https://node.example.com", "tok", pin)))
        // Something that is not a URL is shown as it is, never hidden.
        assertEquals("not a url", pairingGatewayLabel(PairingCode("not a url", "tok", pin)))
    }

    @Test fun `redeem statuses map to failures`() {
        assertEquals(PairingFailure.Expired, pairingFailureForStatus(403))
        assertEquals(PairingFailure.Gone, pairingFailureForStatus(410))
        assertEquals(PairingFailure.Other, pairingFailureForStatus(500))
    }
}

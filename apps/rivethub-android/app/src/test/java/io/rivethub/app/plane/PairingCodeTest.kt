package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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

    @Test fun `redeem statuses map to failures`() {
        assertEquals(PairingFailure.Expired, pairingFailureForStatus(403))
        assertEquals(PairingFailure.Gone, pairingFailureForStatus(410))
        assertEquals(PairingFailure.Other, pairingFailureForStatus(500))
    }
}

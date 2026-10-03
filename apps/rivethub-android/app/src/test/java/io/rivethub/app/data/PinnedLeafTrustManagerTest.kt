package io.rivethub.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

class PinnedLeafTrustManagerTest {
    // Throwaway self-signed P-256 leaf; the CLI's pairing tests pin the same one.
    private val pem = """
        -----BEGIN CERTIFICATE-----
        MIIBfTCCASOgAwIBAgIUeftII8uGDz0GIq3GRfKuY4abqJMwCgYIKoZIzj0EAwIw
        FDESMBAGA1UEAwwJdGVzdC5tZXNoMB4XDTI2MDkzMDE1NDAyNVoXDTM2MDkyNzE1
        NDAyNVowFDESMBAGA1UEAwwJdGVzdC5tZXNoMFkwEwYHKoZIzj0CAQYIKoZIzj0D
        AQcDQgAE4mAjm4fe8MIe4cLK4mqVIHIBDt2IxgSjQxq4U2OnM6LFXK8lTyrHSw9S
        qeSaJIUl8o5cN+t5W2sAYgAJhal7ZqNTMFEwHQYDVR0OBBYEFNaeKB+z3W5npZdQ
        UmjiE8rzbgAAMB8GA1UdIwQYMBaAFNaeKB+z3W5npZdQUmjiE8rzbgAAMA8GA1Ud
        EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAN7sbx1m5LNfbIJqkDlw6T2G
        GpUBux6iHkHNwBl6aw0yAiBb1Y19AqndZYzJH7XGWkIaZTAiP9X4EqTLYxx1RORM
        uA==
        -----END CERTIFICATE-----
    """.trimIndent()
    private val pin = "022ab72bf949c39a134d766ece5b288c60b51780c77540bf84f16b4944e37433"

    private val leaf: X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate

    @Test fun `trusts the leaf the code pins`() {
        val tm = PinnedLeafTrustManager(pin)
        tm.checkServerTrusted(arrayOf(leaf), "ECDHE_ECDSA")
        assertFalse(tm.mismatch)
    }

    @Test fun `refuses any other leaf and flags the mismatch`() {
        val tm = PinnedLeafTrustManager("0".repeat(64))
        assertThrows(CertificateException::class.java) { tm.checkServerTrusted(arrayOf(leaf), "ECDHE_ECDSA") }
        assertTrue(tm.mismatch)
    }

    @Test fun `refuses an empty chain without calling it a mismatch`() {
        val tm = PinnedLeafTrustManager(pin)
        assertThrows(CertificateException::class.java) { tm.checkServerTrusted(emptyArray(), "ECDHE_ECDSA") }
        assertThrows(CertificateException::class.java) { tm.checkServerTrusted(null, "ECDHE_ECDSA") }
        assertFalse(tm.mismatch)
    }

    @Test fun `never accepts client certificates`() {
        assertThrows(CertificateException::class.java) {
            PinnedLeafTrustManager(pin).checkClientTrusted(arrayOf(leaf), "RSA")
        }
    }
}

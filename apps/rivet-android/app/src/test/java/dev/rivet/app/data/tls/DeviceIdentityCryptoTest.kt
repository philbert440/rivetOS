package dev.rivet.app.data.tls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.cert.X509Certificate

/**
 * PKCS#12 parse + trust combination for gateway device mTLS.
 *
 * Fixture `tls/device-test.p12` is a throwaway RSA bag (CN=`device:test-pixel`,
 * OU=client, issued by self-signed "Rivet Test CA"). Passphrase is public test
 * material only — never a fleet secret. No PEM leaves are committed (secret-scan
 * treats base64 cert bodies as key-shaped).
 */
class DeviceIdentityCryptoTest {
    private val passphrase = "test-pass-not-secret".toCharArray()

    private fun loadFixture(): ByteArray {
        val stream = javaClass.classLoader!!.getResourceAsStream("tls/device-test.p12")
            ?: error("missing test resource tls/device-test.p12")
        return stream.use { it.readBytes() }
    }

    @Test
    fun `parses device leaf CN and expiry from p12`() {
        val materials = DeviceIdentityCrypto.parsePkcs12(loadFixture(), passphrase)

        assertEquals("device:test-pixel", materials.summary.commonName)
        assertTrue(
            "notAfter should be in the future for the test fixture",
            materials.summary.notAfterEpochMs > System.currentTimeMillis(),
        )
        assertTrue(materials.summary.subjectDn.contains("device:test-pixel"))
        assertTrue(materials.summary.notAfterLabel().matches(Regex("""\d{4}-\d{2}-\d{2}""")))
    }

    @Test
    fun `extracts Rivet CA anchors from the p12 chain`() {
        val materials = DeviceIdentityCrypto.parsePkcs12(loadFixture(), passphrase)

        assertFalse("expected at least the issuing CA in the bag", materials.caCertificates.isEmpty())
        val caNames = materials.caCertificates.map { it.subjectX500Principal.name }
        assertTrue(
            "fixture CA subject should appear: $caNames",
            caNames.any { it.contains("Rivet Test CA") },
        )
    }

    @Test
    fun `key managers are present for client auth`() {
        val materials = DeviceIdentityCrypto.parsePkcs12(loadFixture(), passphrase)
        val kms = materials.keyManagers()
        assertTrue(kms.isNotEmpty())
    }

    @Test
    fun `wrong passphrase is rejected`() {
        try {
            DeviceIdentityCrypto.parsePkcs12(loadFixture(), "not-the-pass".toCharArray())
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertNotNull(e.message)
        }
    }

    @Test
    fun `empty bag is rejected`() {
        try {
            DeviceIdentityCrypto.parsePkcs12(ByteArray(0), passphrase)
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertNotNull(e.message)
        }
    }

    @Test
    fun `combined trust manager exposes the p12 CA as an accepted issuer`() {
        val materials = DeviceIdentityCrypto.parsePkcs12(loadFixture(), passphrase)
        val tm = DeviceIdentityCrypto.systemPlusExtraTrustManager(materials.caCertificates)
        val system = DeviceIdentityCrypto.systemTrustManager()

        // Extra anchors enlarge the accepted-issuer set past platform roots.
        assertTrue(tm.acceptedIssuers.size >= system.acceptedIssuers.size)
        val issuerNames = tm.acceptedIssuers.map { it.subjectX500Principal.name }
        assertTrue(
            "Rivet Test CA must be among accepted issuers: $issuerNames",
            issuerNames.any { it.contains("Rivet Test CA") },
        )
        // System roots alone must not already include our throwaway CA.
        val systemNames = system.acceptedIssuers.map { it.subjectX500Principal.name }
        assertFalse(systemNames.any { it.contains("Rivet Test CA") })
    }

    @Test
    fun `combined trust with no extras equals system only`() {
        val system = DeviceIdentityCrypto.systemTrustManager()
        val combined = DeviceIdentityCrypto.systemPlusExtraTrustManager(emptyList())
        assertEquals(system.acceptedIssuers.size, combined.acceptedIssuers.size)
    }

    @Test
    fun `sslContext builds with key and trust managers`() {
        val materials = DeviceIdentityCrypto.parsePkcs12(loadFixture(), passphrase)
        val tm = DeviceIdentityCrypto.systemPlusExtraTrustManager(materials.caCertificates)
        val ctx = DeviceIdentityCrypto.sslContext(materials.keyManagers(), tm)
        assertNotNull(ctx.socketFactory)
    }

    @Test
    fun `commonName parser handles RFC2253 subject`() {
        val materials = DeviceIdentityCrypto.parsePkcs12(loadFixture(), passphrase)
        val leaf = materials.keyStore.getCertificateChain(
            materials.keyStore.aliases().asSequence().first { materials.keyStore.isKeyEntry(it) },
        )!![0] as X509Certificate
        assertEquals("device:test-pixel", DeviceIdentityCrypto.commonName(leaf))
    }
}

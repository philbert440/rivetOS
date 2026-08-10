package dev.rivet.app.data.tls

import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.Principal
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.net.ssl.KeyManager
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Parsed device client identity from a Rivet CA PKCS#12 handoff.
 *
 * The p12 holds the device leaf (CN=`device:<id>`, OU=client), its private key,
 * and the Rivet CA chain. CA material is extracted at import time — never
 * committed to the public repo.
 */
data class DeviceCertSummary(
    /** Leaf subject CN, e.g. `device:pixel-phil`. */
    val commonName: String,
    /** Leaf `notAfter` as epoch milliseconds. */
    val notAfterEpochMs: Long,
    /** Full subject DN for diagnostics. */
    val subjectDn: String,
) {
    fun notAfterLabel(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
        return fmt.format(Date(notAfterEpochMs))
    }
}

/**
 * In-memory materials loaded from a PKCS#12. Pure JVM — no Android types — so
 * unit tests can exercise parsing and trust combination without a device.
 */
data class DeviceIdentityMaterials(
    val keyStore: KeyStore,
    val password: CharArray,
    val summary: DeviceCertSummary,
    /** Non-leaf certs from the client chain + any trusted-cert entries. */
    val caCertificates: List<X509Certificate>,
) {
    fun keyManagerFactory(): KeyManagerFactory {
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        kmf.init(keyStore, password)
        return kmf
    }

    fun keyManagers(): Array<KeyManager> = keyManagerFactory().keyManagers
}

/**
 * PKCS#12 parsing + trust-manager composition for Rivet device mTLS.
 *
 * Public / testable surface. Persistence and Android Keystore wrapping live in
 * [DeviceIdentityStore].
 */
object DeviceIdentityCrypto {
    private const val PKCS12 = "PKCS12"

    /**
     * Load and validate a device PKCS#12.
     *
     * @throws IllegalArgumentException when the bag has no private key / leaf,
     *   or the passphrase is wrong.
     */
    fun parsePkcs12(bytes: ByteArray, password: CharArray): DeviceIdentityMaterials {
        require(bytes.isNotEmpty()) { "PKCS#12 is empty" }
        val ks = KeyStore.getInstance(PKCS12)
        try {
            ks.load(ByteArrayInputStream(bytes), password)
        } catch (e: Exception) {
            throw IllegalArgumentException(
                "Could not open PKCS#12 (wrong passphrase or corrupt file)",
                e,
            )
        }

        val keyAlias = ks.aliases().asSequence().firstOrNull { alias ->
            ks.isKeyEntry(alias)
        } ?: throw IllegalArgumentException("PKCS#12 has no private key entry")

        val chain = ks.getCertificateChain(keyAlias)
            ?: throw IllegalArgumentException("PKCS#12 key entry has no certificate chain")
        require(chain.isNotEmpty()) { "PKCS#12 certificate chain is empty" }

        val leaf = chain[0] as? X509Certificate
            ?: throw IllegalArgumentException("Leaf certificate is not X.509")

        val caFromChain = chain.drop(1).mapNotNull { it as? X509Certificate }
        val caFromEntries = ks.aliases().asSequence()
            .filter { alias -> ks.isCertificateEntry(alias) }
            .mapNotNull { alias -> ks.getCertificate(alias) as? X509Certificate }
            .toList()
        // Dedup by serial+issuer so chain intermediates and bag certs don't double.
        val caCertificates = (caFromChain + caFromEntries)
            .distinctBy { it.serialNumber.toString() + "|" + it.issuerX500Principal.name }

        val cn = commonName(leaf) ?: leaf.subjectX500Principal.name
        val summary = DeviceCertSummary(
            commonName = cn,
            notAfterEpochMs = leaf.notAfter.time,
            subjectDn = leaf.subjectX500Principal.name,
        )
        return DeviceIdentityMaterials(
            keyStore = ks,
            password = password.copyOf(),
            summary = summary,
            caCertificates = caCertificates,
        )
    }

    /**
     * TrustManager that accepts either the platform roots or any extra Rivet CA
     * anchors extracted from the device p12.
     *
     * Implemented as a single PKIX trust store (system issuers ∪ extra anchors)
     * rather than try-system-then-extra: dual validators disagree on path
     * building when the leaf is Rivet-CA-signed and not in public roots.
     */
    fun systemPlusExtraTrustManager(extra: List<X509Certificate>): X509TrustManager {
        val system = systemTrustManager()
        if (extra.isEmpty()) return system

        val merged = KeyStore.getInstance(KeyStore.getDefaultType())
        merged.load(null, null)
        system.acceptedIssuers.forEachIndexed { index, cert ->
            // System roots can share subject strings; serial keeps entries unique.
            val alias = "system-$index-${cert.serialNumber}"
            merged.setCertificateEntry(alias, cert)
        }
        extra.forEachIndexed { index, cert ->
            merged.setCertificateEntry("rivet-ca-$index-${cert.serialNumber}", cert)
        }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(merged)
        return tmf.trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()
            ?: throw IllegalStateException("No X509TrustManager from merged trust store")
    }

    fun sslContext(
        keyManagers: Array<KeyManager>,
        trustManager: X509TrustManager,
    ): SSLContext {
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(keyManagers, arrayOf(trustManager), null)
        return ctx
    }

    fun systemTrustManager(): X509TrustManager {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as KeyStore?)
        return tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    /** Best-effort CN from an X.500 subject. */
    fun commonName(cert: X509Certificate): String? {
        val dn = cert.subjectX500Principal.name
        // RFC 2253: CN=value, possibly quoted. Prefer the first CN= segment.
        val match = Regex("""(?:^|,)CN=([^,]+)""").find(dn)
        return match?.groupValues?.get(1)?.trim()?.trim('"')?.takeIf { it.isNotEmpty() }
    }

    /**
     * Subject DNs of Rivet CAs that should authorize offering the device client cert.
     * Includes bag CA entries, chain intermediates, and the leaf issuer.
     */
    fun rivetCaIssuerNames(materials: DeviceIdentityMaterials): Set<String> {
        val names = LinkedHashSet<String>()
        materials.caCertificates.forEach { names.add(it.subjectX500Principal.name) }
        val keyAlias = materials.keyStore.aliases().asSequence()
            .firstOrNull { materials.keyStore.isKeyEntry(it) }
        if (keyAlias != null) {
            val chain = materials.keyStore.getCertificateChain(keyAlias)
            val leaf = chain?.getOrNull(0) as? X509Certificate
            leaf?.issuerX500Principal?.name?.let { names.add(it) }
            chain?.drop(1)?.forEach { cert ->
                (cert as? X509Certificate)?.subjectX500Principal?.name?.let { names.add(it) }
            }
        }
        return names
    }

    /**
     * Whether a TLS CertificateRequest's acceptable-issuers list includes a Rivet CA
     * we imported. Empty/null issuer lists → false (do not present the device cert
     * to arbitrary peers that ask for "any" client cert).
     */
    fun shouldPresentClientCert(
        requestIssuers: Array<out Principal>?,
        rivetCaSubjects: Collection<String>,
    ): Boolean {
        if (requestIssuers.isNullOrEmpty()) return false
        if (rivetCaSubjects.isEmpty()) return false
        return requestIssuers.any { principal -> principal.name in rivetCaSubjects }
    }
}

package dev.rivetos.bots.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.ByteArrayInputStream
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.KeyManager
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * The device's Rivet CA client identity for gateway mTLS.
 *
 * The operator issues `rivet-ca.sh issue-client <device-id>` and hands the phone
 * a PKCS#12. Bytes live app-private in filesDir; the passphrase sits in
 * EncryptedSharedPreferences (Android Keystore-backed). The CA chain is taken
 * from the p12 (and/or an optional CA PEM) — nothing is baked into the APK.
 */
class DeviceIdentityStore(context: Context) {
    private val app = context.applicationContext
    private val p12File = File(app.filesDir, P12_FILE)
    private val caFile = File(app.filesDir, CA_FILE)
    private val vault: SharedPreferences = openVault(app)
    private val lock = Any()
    private val generation = AtomicInteger(0)

    @Volatile private var cached: Loaded? = null
    @Volatile private var cachedGen = -1
    /** Why the stored identity failed to load (bad passphrase vault, corrupt file), if it did. */
    @Volatile var lastError: String? = null
        private set

    data class Summary(
        val cn: String,
        val deviceId: String,
        val notAfter: Long,
        val issuer: String,
        val hasCaChain: Boolean,
    )

    class Loaded(
        val keyManagers: Array<KeyManager>,
        val trustManager: X509TrustManager?,
        val summary: Summary,
    )

    /** Bumped on import/clear so HTTP clients rebuild once, not per request. */
    fun generation(): Int = generation.get()

    fun hasIdentity(): Boolean = synchronized(lock) {
        p12File.isFile && p12File.length() > 0 && !vault.getString(KEY_PASS, null).isNullOrEmpty()
    }

    fun summary(): Summary? = load()?.summary

    /** Replace the identity. Throws IllegalArgumentException on a bad passphrase / keyless p12. */
    fun importPkcs12(bytes: ByteArray, passphrase: String): Summary {
        val parsed = parse(bytes, passphrase.toCharArray(), extraCa = readCaPem())
        synchronized(lock) {
            val tmp = File(app.filesDir, "$P12_FILE.tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(p12File)) {
                p12File.writeBytes(bytes)
                tmp.delete()
            }
            if (!vault.edit().putString(KEY_PASS, passphrase).commit()) {
                throw IllegalStateException("could not store passphrase")
            }
            cached = null
            generation.incrementAndGet()
        }
        return parsed.summary
    }

    /** Optional extra trust anchors (PEM bundle) for nodes whose chain isn't in the p12. */
    fun importCaPem(bytes: ByteArray): Int {
        val certs = pemCerts(bytes)
        require(certs.isNotEmpty()) { "no certificates found in PEM" }
        synchronized(lock) {
            caFile.writeBytes(bytes)
            cached = null
            generation.incrementAndGet()
        }
        return certs.size
    }

    fun hasCaPem(): Boolean = caFile.isFile && caFile.length() > 0

    fun clear() = synchronized(lock) {
        p12File.delete()
        caFile.delete()
        vault.edit().remove(KEY_PASS).commit()
        cached = null
        generation.incrementAndGet()
    }

    fun load(): Loaded? {
        val gen = generation.get()
        cached?.let { if (cachedGen == gen) return it }
        synchronized(lock) {
            if (!hasIdentity()) return null
            val pass = vault.getString(KEY_PASS, null) ?: return null
            return try {
                val loaded = parse(p12File.readBytes(), pass.toCharArray(), extraCa = readCaPem())
                cached = loaded
                cachedGen = gen
                lastError = null
                loaded
            } catch (e: Exception) {
                // Not cached: a transient read error must not pin this generation to "no identity".
                lastError = e.message ?: e.javaClass.simpleName
                null
            }
        }
    }

    private fun readCaPem(): List<X509Certificate> =
        if (hasCaPem()) runCatching { pemCerts(caFile.readBytes()) }.getOrDefault(emptyList()) else emptyList()

    private fun parse(bytes: ByteArray, password: CharArray, extraCa: List<X509Certificate>): Loaded {
        val ks = KeyStore.getInstance("PKCS12")
        try {
            ks.load(ByteArrayInputStream(bytes), password)
        } catch (e: Exception) {
            throw IllegalArgumentException("could not open PKCS#12 (wrong passphrase?)", e)
        }
        val alias = ks.aliases().toList().firstOrNull { ks.isKeyEntry(it) }
            ?: throw IllegalArgumentException("PKCS#12 has no private key")
        val chain = ks.getCertificateChain(alias)?.filterIsInstance<X509Certificate>().orEmpty()
        val leaf = chain.firstOrNull() ?: throw IllegalArgumentException("PKCS#12 has no certificate")

        // Trust anchors: everything in the chain above the leaf, any trusted-cert
        // entries in the p12, plus the optional CA PEM.
        val anchors = LinkedHashSet<X509Certificate>()
        chain.drop(1).forEach { anchors.add(it) }
        ks.aliases().toList().filter { ks.isCertificateEntry(it) }.forEach { a ->
            (ks.getCertificate(a) as? X509Certificate)?.let { anchors.add(it) }
        }
        anchors.addAll(extraCa)

        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        kmf.init(ks, password)

        val trust: X509TrustManager? = if (anchors.isEmpty()) null else {
            val tks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
            anchors.forEachIndexed { i, c -> tks.setCertificateEntry("ca$i", c) }
            val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            tmf.init(tks)
            tmf.trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()
        }

        val cn = leaf.subjectX500Principal.name
            .split(',').map { it.trim() }.firstOrNull { it.startsWith("CN=") }?.removePrefix("CN=") ?: ""
        val summary = Summary(
            cn = cn,
            deviceId = cn.removePrefix("device:"),
            notAfter = leaf.notAfter.time,
            issuer = leaf.issuerX500Principal.name.split(',').firstOrNull()?.removePrefix("CN=") ?: "",
            hasCaChain = anchors.isNotEmpty(),
        )
        return Loaded(kmf.keyManagers, trust, summary)
    }

    /** 6-hex tag derived from the leaf CN — keys per-device session ids. */
    fun deviceTag(): String {
        val cn = summary()?.cn ?: "anon"
        val d = MessageDigest.getInstance("SHA-256").digest(cn.toByteArray())
        return d.take(3).joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val P12_FILE = "device-identity.p12"
        private const val CA_FILE = "trust-anchors.pem"
        private const val KEY_PASS = "p12.passphrase"

        private fun openVault(ctx: Context): SharedPreferences {
            val master = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            return EncryptedSharedPreferences.create(
                ctx,
                "identity-vault",
                master,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }

        fun pemCerts(bytes: ByteArray): List<X509Certificate> {
            val cf = CertificateFactory.getInstance("X.509")
            return cf.generateCertificates(ByteArrayInputStream(bytes)).filterIsInstance<X509Certificate>()
        }
    }
}
